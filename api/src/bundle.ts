import { createHash } from "node:crypto";

/**
 * A model bundle is a zip exported from Blockbench that the client mod renders: geometry
 * (Bedrock/GeckoLib format), one texture and optional animations. Bundles are named by the
 * SHA-256 of their bytes, so a published bundle never changes and caches forever.
 */
export const BUNDLE_FILES = { required: ["geometry.json", "texture.png"], optional: ["animations.json"] };
export const MAX_BUNDLE_BYTES = 256 * 1024;
/** Per file, after decompression. The client enforces the same limit while inflating. */
export const MAX_ENTRY_BYTES = 1024 * 1024;

export class BundleError extends Error {}

/** Checks a bundle's structure from its zip directory and returns its id (hex SHA-256). */
export function validateBundle(zip: Buffer): string {
  if (zip.length > MAX_BUNDLE_BYTES) throw new BundleError(`bundle is over ${MAX_BUNDLE_BYTES} bytes`);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length) throw new BundleError("not a zip file");

  const allowed = new Set([...BUNDLE_FILES.required, ...BUNDLE_FILES.optional]);
  const seen = new Set<string>();
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new BundleError("corrupt zip directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (!allowed.has(name)) throw new BundleError(`unexpected file "${name}"; bundles hold only ${[...allowed].join(", ")}`);
    if (seen.has(name)) throw new BundleError(`duplicate file "${name}"`);
    if (method !== 0 && method !== 8) throw new BundleError(`"${name}" uses an unsupported compression method`);
    if (size > MAX_ENTRY_BYTES) throw new BundleError(`"${name}" is over ${MAX_ENTRY_BYTES} bytes`);
    seen.add(name);
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  for (const name of BUNDLE_FILES.required) {
    if (!seen.has(name)) throw new BundleError(`missing ${name}`);
  }
  return createHash("sha256").update(zip).digest("hex");
}
