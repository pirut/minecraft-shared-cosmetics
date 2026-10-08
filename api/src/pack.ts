import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32 } from "node:zlib";

export interface ResourcePack {
  zip: Buffer;
  /** Lowercase hex SHA-1 of the zip, which is what Minecraft clients verify and cache by. */
  sha1: string;
}

/** The resource pack folder at the repo root. */
export const DEFAULT_PACK_DIR = new URL("../../resourcepack", import.meta.url).pathname;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")))
    .sort();
}

/**
 * Zips the pack folder. Entries are stored uncompressed (PNGs are already compressed) in
 * sorted order with fixed timestamps, so the output is byte-for-byte reproducible: the same
 * assets give the same SHA-1 on any machine and any Node version.
 */
export function buildPack(dir: string = DEFAULT_PACK_DIR): ResourcePack {
  const files = listFiles(dir);
  if (!files.includes("pack.mcmeta")) throw new Error(`${dir} has no pack.mcmeta`);
  const entries = files.map((path) => {
    const data = readFileSync(join(dir, path));
    if (path.endsWith(".json") || path.endsWith(".mcmeta")) {
      try {
        JSON.parse(data.toString("utf8"));
      } catch (e) {
        throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
      }
    }
    return { name: path, data };
  });
  const zip = storedZip(entries);
  return { zip, sha1: createHash("sha1").update(zip).digest("hex") };
}

/** Writes entries, in the order given, as an uncompressed zip with fixed timestamps. */
export function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name: path, data } of entries) {
    const name = Buffer.from(path, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // 00:00:00
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    local.copy(central, 6, 4, 30); // same fields as the local header
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
