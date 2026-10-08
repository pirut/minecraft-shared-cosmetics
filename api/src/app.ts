import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SLOT_FOR_TYPE, type CosmeticType, type Store } from "./db.ts";

export interface RateLimitOptions {
  /** Requests per window for each server key. */
  serverMax: number;
  /** Requests per window for each IP without a valid key (public catalog, bad tokens). */
  anonymousMax: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { serverMax: 600, anonymousMax: 60, windowMs: 60_000 };

export interface AppOptions {
  store: Store;
  /** Token for catalog management, server registration and grants. */
  adminToken: string;
  logger?: boolean;
  /** Trust X-Forwarded-For from a load balancer (Fly, Railway, nginx) so per-IP limits see the real client. */
  trustProxy?: boolean;
  /** `false` turns rate limiting off. */
  rateLimit?: RateLimitOptions | false;
}

type Caller = { kind: "admin" } | { kind: "server"; id: string } | { kind: "anonymous" };

declare module "fastify" {
  interface FastifyRequest {
    caller: Caller;
  }
}

/** How long an old key keeps working after a rotation unless the admin says otherwise. */
const DEFAULT_ROTATION_GRACE_SECONDS = 24 * 60 * 60;
const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const ID_RE = "^[a-z0-9_]{1,64}$";

/** Accepts dashed or undashed Mojang UUIDs and returns the canonical dashed lowercase form. */
export function normalizeUuid(raw: string): string | undefined {
  if (!UUID_RE.test(raw)) return undefined;
  const hex = raw.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { store, adminToken } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  // Work out who is calling up front so the rate limiter can key on it; routes enforce access below.
  app.decorateRequest<Caller | null>("caller", null);
  app.addHook("onRequest", async (req) => {
    const token = bearer(req);
    if (token && safeEqual(token, adminToken)) {
      req.caller = { kind: "admin" };
      return;
    }
    const server = token ? await store.findServerByKeyHash(hashKey(token)) : undefined;
    req.caller = server ? { kind: "server", id: server.id } : { kind: "anonymous" };
  });

  const limits = opts.rateLimit === undefined ? DEFAULT_RATE_LIMIT : opts.rateLimit;
  if (limits) {
    // Must finish registering before routes are declared, or they won't be limited.
    await app.register(rateLimit, {
      // The plugin attaches its check to each route's onRequest, which runs after the app-level hook above.
      timeWindow: limits.windowMs,
      // Many Minecraft hosts put dozens of servers behind one IP, so valid keys get their own bucket.
      keyGenerator: (req) => (req.caller.kind === "server" ? `server:${req.caller.id}` : `ip:${req.ip}`),
      max: (_req, key) => (key.startsWith("server:") ? limits.serverMax : limits.anonymousMax),
      allowList: (req) => req.caller.kind === "admin",
    });
  }

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.caller.kind !== "admin") return reply.code(401).send({ error: "admin token required" });
  };

  const requireServer = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.caller.kind !== "server") return reply.code(401).send({ error: "valid server key required" });
  };

  const newServerKey = () => `msc_${randomBytes(24).toString("base64url")}`;

  const playerUuid = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
    const uuid = normalizeUuid((req.params as { uuid: string }).uuid);
    if (!uuid) reply.code(400).send({ error: "invalid player uuid" });
    return uuid;
  };

  app.get("/health", { config: { rateLimit: false } }, async () => ({ ok: true }));

  // Public: the whole catalog, so servers can cache render hints.
  app.get("/v1/cosmetics", async () => ({ cosmetics: await store.listCosmetics() }));

  app.put<{ Params: { id: string }; Body: { name: string; type: CosmeticType; data?: Record<string, unknown> } }>(
    "/v1/cosmetics/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: "object", properties: { id: { type: "string", pattern: ID_RE } } },
        body: {
          type: "object",
          required: ["name", "type"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            type: { type: "string", enum: Object.keys(SLOT_FOR_TYPE) },
            data: { type: "object" },
          },
        },
      },
    },
    async (req) => store.upsertCosmetic({ id: req.params.id, name: req.body.name, type: req.body.type, data: req.body.data ?? {} }),
  );

  // Registers a server and returns its API key. The key is only shown once.
  app.post<{ Body: { name: string } }>(
    "/v1/servers",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const id = randomBytes(6).toString("hex");
      const key = newServerKey();
      await store.createServer(id, req.body.name, hashKey(key));
      return reply.code(201).send({ id, name: req.body.name, key });
    },
  );

  app.get("/v1/servers", { preHandler: requireAdmin }, async () => ({ servers: await store.listServers() }));

  // Issues a new key. The old one keeps working for `graceSeconds` (default 24h) so the
  // server owner can update their config without downtime; pass 0 if the old key leaked.
  app.post<{ Params: { id: string }; Body: { graceSeconds?: number } | undefined }>(
    "/v1/servers/:id/rotate",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: ["object", "null"],
          properties: { graceSeconds: { type: "integer", minimum: 0, maximum: MAX_ROTATION_GRACE_SECONDS } },
        },
      },
    },
    async (req, reply) => {
      const graceSeconds = req.body?.graceSeconds ?? DEFAULT_ROTATION_GRACE_SECONDS;
      const key = newServerKey();
      if (!(await store.rotateServerKey(req.params.id, hashKey(key), graceSeconds * 1000))) {
        return reply.code(404).send({ error: "unknown or revoked server" });
      }
      return { id: req.params.id, key, oldKeysExpireInSeconds: graceSeconds };
    },
  );

  // Permanently cuts a server off. Register it again to give it a fresh identity.
  app.delete<{ Params: { id: string } }>("/v1/servers/:id", { preHandler: requireAdmin }, async (req, reply) => {
    if (!(await store.revokeServer(req.params.id))) return reply.code(404).send({ error: "unknown server" });
    return reply.code(204).send();
  });

  app.post<{ Params: { uuid: string }; Body: { cosmeticId: string } }>(
    "/v1/players/:uuid/grants",
    {
      preHandler: requireAdmin,
      schema: {
        body: { type: "object", required: ["cosmeticId"], properties: { cosmeticId: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      if (!(await store.getCosmetic(req.body.cosmeticId))) return reply.code(404).send({ error: "unknown cosmetic" });
      await store.grant(uuid, req.body.cosmeticId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { uuid: string } }>("/v1/players/:uuid", { preHandler: requireServer }, async (req, reply) => {
    const uuid = playerUuid(req, reply);
    if (!uuid) return;
    return { uuid, owned: await store.ownedCosmetics(uuid), equipped: await store.equipped(uuid) };
  });

  app.put<{ Params: { uuid: string; slot: string }; Body: { cosmeticId: string } }>(
    "/v1/players/:uuid/equipped/:slot",
    {
      preHandler: requireServer,
      schema: {
        body: { type: "object", required: ["cosmeticId"], properties: { cosmeticId: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      const cosmetic = await store.getCosmetic(req.body.cosmeticId);
      if (!cosmetic) return reply.code(404).send({ error: "unknown cosmetic" });
      if (cosmetic.slot !== req.params.slot) return reply.code(400).send({ error: `cosmetic belongs in slot "${cosmetic.slot}"` });
      // Servers may only equip what the player already owns; only admins grant.
      if (!(await store.owns(uuid, cosmetic.id))) return reply.code(403).send({ error: "player does not own this cosmetic" });
      await store.equip(uuid, req.params.slot, cosmetic.id);
      return { uuid, equipped: await store.equipped(uuid) };
    },
  );

  app.delete<{ Params: { uuid: string; slot: string } }>(
    "/v1/players/:uuid/equipped/:slot",
    { preHandler: requireServer },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      await store.unequip(uuid, req.params.slot);
      return { uuid, equipped: await store.equipped(uuid) };
    },
  );

  return app;
}
