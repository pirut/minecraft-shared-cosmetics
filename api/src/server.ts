import { existsSync } from "node:fs";
import { buildApp } from "./app.ts";
import { Store } from "./db.ts";
import { DEFAULT_PACK_DIR, buildPack } from "./pack.ts";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) {
  console.error("ADMIN_TOKEN must be set to a secret of at least 16 characters");
  process.exit(1);
}

const packDir = process.env.PACK_DIR ?? DEFAULT_PACK_DIR;
const pack = existsSync(packDir) ? buildPack(packDir) : undefined;

const store = new Store(process.env.DATABASE_PATH ?? "cosmetics.db");
const app = buildApp({
  store,
  adminToken,
  publicUrl: process.env.PUBLIC_URL,
  trustProxy: process.env.TRUST_PROXY === "1",
  logger: true,
  pack,
  packUrl: process.env.PACK_URL || undefined,
});
if (pack) app.log.info({ sha1: pack.sha1, bytes: pack.zip.length }, `resource pack built from ${packDir}`);
else app.log.warn(`no resource pack at ${packDir}; custom hat models won't load`);

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
