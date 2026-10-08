// Builds the shared resource pack for static hosting: writes the zip and prints its SHA-1.
// Usage: npm run build-pack [-- <out-dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPack } from "../src/pack.ts";

const outDir = process.argv[2] ?? "dist";
const pack = buildPack(process.env.PACK_DIR);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `sharedcosmetics-${pack.sha1}.zip`);
writeFileSync(file, pack.zip);
writeFileSync(join(outDir, "sharedcosmetics.sha1"), `${pack.sha1}\n`);
console.log(`${file}\n${pack.zip.length} bytes, sha1 ${pack.sha1}`);
