import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SLOT_FOR_TYPE, Store, type CosmeticType } from "./db.ts";

export interface AppOptions {
  store: Store;
  /** Token for catalog management, server registration and grants. */
  adminToken: string;
  logger?: boolean;
}

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

export function buildApp(opts: AppOptions): FastifyInstance {
  const { store, adminToken } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, adminToken)) {
      return reply.code(401).send({ error: "admin token required" });
    }
  };

  const requireServer = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const server = token ? store.findServerByKeyHash(hashKey(token)) : undefined;
    if (!server) return reply.code(401).send({ error: "valid server key required" });
  };

  const playerUuid = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
    const uuid = normalizeUuid((req.params as { uuid: string }).uuid);
    if (!uuid) reply.code(400).send({ error: "invalid player uuid" });
    return uuid;
  };

  app.get("/health", async () => ({ ok: true }));

  // Public: the whole catalog, so servers can cache render hints.
  app.get("/v1/cosmetics", async () => ({ cosmetics: store.listCosmetics() }));

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
      const key = `msc_${randomBytes(24).toString("base64url")}`;
      store.createServer(id, req.body.name, hashKey(key));
      return reply.code(201).send({ id, name: req.body.name, key });
    },
  );

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
      if (!store.getCosmetic(req.body.cosmeticId)) return reply.code(404).send({ error: "unknown cosmetic" });
      store.grant(uuid, req.body.cosmeticId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { uuid: string } }>("/v1/players/:uuid", { preHandler: requireServer }, async (req, reply) => {
    const uuid = playerUuid(req, reply);
    if (!uuid) return;
    return { uuid, owned: store.ownedCosmetics(uuid), equipped: store.equipped(uuid) };
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
      const cosmetic = store.getCosmetic(req.body.cosmeticId);
      if (!cosmetic) return reply.code(404).send({ error: "unknown cosmetic" });
      if (cosmetic.slot !== req.params.slot) return reply.code(400).send({ error: `cosmetic belongs in slot "${cosmetic.slot}"` });
      // Servers may only equip what the player already owns; only admins grant.
      if (!store.owns(uuid, cosmetic.id)) return reply.code(403).send({ error: "player does not own this cosmetic" });
      store.equip(uuid, req.params.slot, cosmetic.id);
      return { uuid, equipped: store.equipped(uuid) };
    },
  );

  app.delete<{ Params: { uuid: string; slot: string } }>(
    "/v1/players/:uuid/equipped/:slot",
    { preHandler: requireServer },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      store.unequip(uuid, req.params.slot);
      return { uuid, equipped: store.equipped(uuid) };
    },
  );

  return app;
}
