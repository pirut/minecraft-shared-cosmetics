import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { KIT_SCHEMA } from "./kit.ts";
import { SLOT_FOR_TYPE, type CosmeticType, type Store } from "./db.ts";
import type { ResourcePack } from "./pack.ts";
import { ChangeFeed } from "./events.ts";

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
  /** Where players reach the web pages, e.g. https://cosmetics.example.com. Defaults to the request's host. */
  publicUrl?: string;
  logger?: boolean;
  /** Trust X-Forwarded-For from a load balancer (Fly, Railway, nginx) so per-IP limits see the real client. */
  trustProxy?: boolean;
  /** `false` turns rate limiting off. */
  rateLimit?: RateLimitOptions | false;
  /** The shared resource pack, served at /v1/pack/<sha1>.zip. Omit to run without one. */
  pack?: ResourcePack;
  /** Where players download the pack if it's hosted elsewhere (a CDN). Must serve the same bytes. */
  packUrl?: string;
  /** How often the event stream sends a keep-alive comment, so servers can spot dead connections. */
  heartbeatMs?: number;
}

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "msc_session";
// No 0/O or 1/I so codes survive being read off a Minecraft chat line.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_FAILURES_PER_WINDOW = 10;
const LINK_FAILURE_WINDOW_MS = 10 * 60 * 1000;

const PAGES = {
  player: readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
  admin: readFileSync(new URL("../public/admin.html", import.meta.url), "utf8"),
};

/** Eight characters from CODE_ALPHABET, shown to players as XXXX-XXXX. */
export function newLinkCode(): string {
  return Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
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
  const publicUrl = (req: FastifyRequest) => (opts.publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, "");
  const linkFailures = new Map<string, { count: number; resetAt: number }>();
  const feed = new ChangeFeed();
  const closeStreams = new Set<() => void>();

  const publishPlayer = async (uuid: string) =>
    feed.publish({
      type: "player",
      uuid,
      owned: (await store.ownedCosmetics(uuid)).map((c) => c.id),
      equipped: await store.equipped(uuid),
    });

  // Open event streams would otherwise keep app.close() waiting forever.
  app.addHook("preClose", async () => {
    for (const close of closeStreams) close();
  });

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

  const sessionPlayer = async (req: FastifyRequest): Promise<string | undefined> => {
    const token = cookie(req, SESSION_COOKIE);
    return token ? store.findSession(hashKey(token)) : undefined;
  };

  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await sessionPlayer(req))) return reply.code(401).send({ error: "not linked" });
  };

  const profile = async (uuid: string) => ({
    uuid,
    name: (await store.getPlayer(uuid))?.name ?? null,
    owned: await store.ownedCosmetics(uuid),
    equipped: await store.equipped(uuid),
  });

  /** Shared by servers and the player's own web session; only owned cosmetics can be equipped. */
  const equip = async (uuid: string, slot: string, cosmeticId: string, reply: FastifyReply) => {
    const cosmetic = await store.getCosmetic(cosmeticId);
    if (!cosmetic) return reply.code(404).send({ error: "unknown cosmetic" });
    if (cosmetic.slot !== slot) return reply.code(400).send({ error: `cosmetic belongs in slot "${cosmetic.slot}"` });
    if (!(await store.owns(uuid, cosmetic.id))) return reply.code(403).send({ error: "player does not own this cosmetic" });
    await store.equip(uuid, slot, cosmetic.id);
    await publishPlayer(uuid);
    return { uuid, equipped: await store.equipped(uuid) };
  };

  const newServerKey = () => `msc_${randomBytes(24).toString("base64url")}`;

  const playerUuid = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
    const uuid = normalizeUuid((req.params as { uuid: string }).uuid);
    if (!uuid) reply.code(400).send({ error: "invalid player uuid" });
    return uuid;
  };

  app.get("/health", { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(PAGES.player));
  app.get("/admin", async (_req, reply) => reply.type("text/html; charset=utf-8").send(PAGES.admin));

  // Public: the whole catalog, so servers can cache render hints.
  app.get("/v1/cosmetics", async () => ({ cosmetics: await store.listCosmetics() }));

  // Public: what servers send players on join. Clients verify the download against sha1.
  app.get("/v1/pack", async (_req, reply) => {
    const { pack, packUrl } = opts;
    if (!pack) return reply.code(404).send({ error: "no resource pack configured" });
    const path = `/v1/pack/${pack.sha1}.zip`;
    return { sha1: pack.sha1, size: pack.zip.length, path, ...(packUrl ? { url: packUrl } : {}) };
  });

  // The hash is in the path so caches and CDNs never serve a stale pack under a new hash.
  app.get<{ Params: { file: string } }>("/v1/pack/:file", async (req, reply) => {
    const { pack } = opts;
    if (!pack || req.params.file !== `${pack.sha1}.zip`) return reply.code(404).send({ error: "unknown pack" });
    return reply
      .header("Content-Type", "application/zip")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(pack.zip);
  });

  app.put<{
    Params: { id: string };
    Body: { name: string; type: CosmeticType; claimable?: boolean; data?: Record<string, unknown> };
  }>(
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
            claimable: { type: "boolean" },
            data: { type: "object", properties: { kit: KIT_SCHEMA } },
          },
        },
      },
    },
    async (req) => {
      const cosmetic = await store.upsertCosmetic({
        id: req.params.id,
        name: req.body.name,
        type: req.body.type,
        claimable: req.body.claimable ?? false,
        data: req.body.data ?? {},
      });
      feed.publish({ type: "catalog", id: cosmetic.id });
      return cosmetic;
    },
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

  // Admin lookup by uuid or by any name a server has reported.
  app.get<{ Params: { query: string } }>("/v1/admin/players/:query", { preHandler: requireAdmin }, async (req, reply) => {
    const uuid = normalizeUuid(req.params.query) ?? (await store.findPlayerByName(req.params.query))?.uuid;
    if (!uuid) return reply.code(404).send({ error: "no player with that uuid or name has been seen yet" });
    return profile(uuid);
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
      await publishPlayer(uuid);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { uuid: string; cosmeticId: string } }>(
    "/v1/players/:uuid/grants/:cosmeticId",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      await store.revoke(uuid, req.params.cosmeticId);
      await publishPlayer(uuid);
      return reply.code(204).send();
    },
  );

  // Servers pass ?name= so admins can find players by name later.
  app.get<{ Params: { uuid: string }; Querystring: { name?: string } }>(
    "/v1/players/:uuid",
    {
      preHandler: requireServer,
      schema: { querystring: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z0-9_]{1,16}$" } } } },
    },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      if (req.query.name) await store.seePlayer(uuid, req.query.name);
      return profile(uuid);
    },
  );

  // A server asks for a one-time code on behalf of an online player (/cosmetics link).
  // The player types it into the web page to prove they own the account, no Microsoft login needed.
  app.post<{ Params: { uuid: string }; Body: { name?: string } }>(
    "/v1/players/:uuid/link-codes",
    {
      preHandler: requireServer,
      schema: { body: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z0-9_]{1,16}$" } } } },
    },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      if (req.body?.name) await store.seePlayer(uuid, req.body.name);
      const code = newLinkCode();
      const expiresAt = Date.now() + LINK_CODE_TTL_MS;
      await store.createLinkCode(code, uuid, expiresAt);
      const display = `${code.slice(0, 4)}-${code.slice(4)}`;
      return reply.code(201).send({ code: display, expiresAt, url: `${publicUrl(req)}/?code=${display}` });
    },
  );

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
      // Servers may only equip what the player already owns; they can never grant.
      return equip(uuid, req.params.slot, req.body.cosmeticId, reply);
    },
  );

  app.delete<{ Params: { uuid: string; slot: string } }>(
    "/v1/players/:uuid/equipped/:slot",
    { preHandler: requireServer },
    async (req, reply) => {
      const uuid = playerUuid(req, reply);
      if (!uuid) return;
      await store.unequip(uuid, req.params.slot);
      await publishPlayer(uuid);
      return { uuid, equipped: await store.equipped(uuid) };
    },
  );

  // Player web session. Exchanging a link code sets an httpOnly cookie tied to the code's uuid.
  app.post<{ Body: { code: string } }>(
    "/v1/session",
    { schema: { body: { type: "object", required: ["code"], properties: { code: { type: "string", maxLength: 32 } } } } },
    async (req, reply) => {
      const now = Date.now();
      const failures = linkFailures.get(req.ip);
      if (failures && failures.resetAt > now && failures.count >= LINK_FAILURES_PER_WINDOW) {
        return reply.code(429).send({ error: "too many wrong codes, try again in a few minutes" });
      }
      const uuid = await store.consumeLinkCode(normalizeLinkCode(req.body.code));
      if (!uuid) {
        const entry = failures && failures.resetAt > now ? failures : { count: 0, resetAt: now + LINK_FAILURE_WINDOW_MS };
        entry.count++;
        linkFailures.set(req.ip, entry);
        return reply.code(400).send({ error: "that code is wrong or has expired, run /cosmetics link again" });
      }
      const token = randomBytes(32).toString("base64url");
      await store.createSession(hashKey(token), uuid, now + SESSION_TTL_MS);
      const secure = publicUrl(req).startsWith("https:") ? "; Secure" : "";
      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      );
      return profile(uuid);
    },
  );

  app.delete("/v1/session", async (req, reply) => {
    const token = cookie(req, SESSION_COOKIE);
    if (token) await store.deleteSession(hashKey(token));
    reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.code(204).send();
  });

  app.get("/v1/me", { preHandler: requireSession }, async (req) => profile((await sessionPlayer(req))!));

  app.post<{ Body: { cosmeticId: string } }>(
    "/v1/me/claims",
    {
      preHandler: requireSession,
      schema: { body: { type: "object", required: ["cosmeticId"], properties: { cosmeticId: { type: "string" } } } },
    },
    async (req, reply) => {
      const uuid = (await sessionPlayer(req))!;
      const cosmetic = await store.getCosmetic(req.body.cosmeticId);
      if (!cosmetic) return reply.code(404).send({ error: "unknown cosmetic" });
      if (!cosmetic.claimable) return reply.code(403).send({ error: "this cosmetic can't be claimed" });
      await store.grant(uuid, cosmetic.id);
      await publishPlayer(uuid);
      return profile(uuid);
    },
  );

  app.put<{ Params: { slot: string }; Body: { cosmeticId: string } }>(
    "/v1/me/equipped/:slot",
    {
      preHandler: requireSession,
      schema: { body: { type: "object", required: ["cosmeticId"], properties: { cosmeticId: { type: "string" } } } },
    },
    async (req, reply) => equip((await sessionPlayer(req))!, req.params.slot, req.body.cosmeticId, reply),
  );

  app.delete<{ Params: { slot: string } }>("/v1/me/equipped/:slot", { preHandler: requireSession }, async (req) => {
    const uuid = (await sessionPlayer(req))!;
    await store.unequip(uuid, req.params.slot);
    await publishPlayer(uuid);
    return { uuid, equipped: await store.equipped(uuid) };
  });

  // Server-sent events: every change to any player or the catalog, as it happens, so a cosmetic
  // equipped on one server shows up on the others without the player rejoining.
  // One API instance only for now: with several behind a load balancer, each server only hears
  // changes made through the instance it's connected to (see events.ts).
  app.get("/v1/events", { preHandler: requireServer }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Stops nginx and similar proxies from buffering the stream.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = feed.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.heartbeatMs ?? 25_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      closeStreams.delete(close);
      res.end();
    };
    closeStreams.add(close);
    req.raw.on("close", close);
  });

  return app;
}
