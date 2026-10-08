import { buildApp } from "./app.ts";
import { Store } from "./db.ts";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) {
  console.error("ADMIN_TOKEN must be set to a secret of at least 16 characters");
  process.exit(1);
}

const store = new Store(process.env.DATABASE_PATH ?? "cosmetics.db");
const app = buildApp({ store, adminToken, logger: true });

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
