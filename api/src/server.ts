import { existsSync } from "node:fs";
import { buildApp, DEFAULT_RATE_LIMIT } from "./app.ts";
import { openStore } from "./db.ts";
import { DEFAULT_PACK_DIR, buildPack } from "./pack.ts";

const env = process.env;

const adminToken = env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) {
  console.error("ADMIN_TOKEN must be set to a secret of at least 16 characters");
  process.exit(1);
}

const truthy = (v: string | undefined) => v === "1" || v === "true";
const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

const packDir = env.PACK_DIR ?? DEFAULT_PACK_DIR;
const pack = existsSync(packDir) ? buildPack(packDir) : undefined;

// DATABASE_URL (postgres://...) for hosting; DATABASE_PATH (a SQLite file) for local runs.
const store = await openStore(env.DATABASE_URL || env.DATABASE_PATH || "cosmetics.db");
const app = await buildApp({
  store,
  adminToken,
  logger: true,
  pack,
  packUrl: env.PACK_URL || undefined,
  trustProxy: truthy(env.TRUST_PROXY),
  rateLimit: truthy(env.RATE_LIMIT_DISABLED)
    ? false
    : {
        serverMax: num(env.RATE_LIMIT_SERVER_MAX, DEFAULT_RATE_LIMIT.serverMax),
        anonymousMax: num(env.RATE_LIMIT_ANONYMOUS_MAX, DEFAULT_RATE_LIMIT.anonymousMax),
        windowMs: num(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT.windowMs),
      },
});
app.addHook("onClose", () => store.close());
if (pack) app.log.info({ sha1: pack.sha1, bytes: pack.zip.length }, `resource pack built from ${packDir}`);
else app.log.warn(`no resource pack at ${packDir}; custom hat models won't load`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.PORT ?? 8080) });
