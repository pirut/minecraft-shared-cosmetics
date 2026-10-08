import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SLOT_FOR_TYPE, Store, type CosmeticType } from "./db.ts";
import type { ResourcePack } from "./pack.ts";
import { ChangeFeed } from "./events.ts";

export interface AppOptions {
  store: Store;
  /** Token for catalog management, server registration and grants. */
  adminToken: string;
  logger?: boolean;
  /** The shared resource pack, served at /v1/pack/<sha1>.zip. Omit to run without one. */
  pack?: ResourcePack;
  /** Where players download the pack if it's hosted elsewhere (a CDN). Must serve the same bytes. */
  packUrl?: string;
  /** How often the event stream sends a keep-alive comment, so servers can spot dead connections. */
  heartbeatMs?: number;
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
  const feed = new ChangeFeed();
  const closeStreams = new Set<() => void>();

  const publishPlayer = (uuid: string) =>
    feed.publish({
      type: "player",
      uuid,
      owned: store.ownedCosmetics(uuid).map((c) => c.id),
      equipped: store.equipped(uuid),
    });

  // Open event streams would otherwise keep app.close() waiting forever.
  app.addHook("preClose", async () => {
    for (const close of closeStreams) close();
  });

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
    async (req) => {
      const cosmetic = store.upsertCosmetic({ id: req.params.id, name: req.body.name, type: req.body.type, data: req.body.data ?? {} });
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
      publishPlayer(uuid);
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
      publishPlayer(uuid);
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
      publishPlayer(uuid);
      return { uuid, equipped: store.equipped(uuid) };
    },
  );

  // Server-sent events: every change to any player or the catalog, as it happens, so a cosmetic
  // equipped on one server shows up on the others without the player rejoining.
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
