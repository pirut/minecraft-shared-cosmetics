import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { buildPack } from "../src/pack.ts";

const ADMIN = "test-admin-token-123456";

/** Entry names from the zip's central directory. */
function zipEntries(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLen = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + nameLen).toString("utf8"));
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

test("the repo pack builds reproducibly and contains the top hat", () => {
  const a = buildPack();
  const b = buildPack();
  assert.equal(a.sha1, b.sha1);
  assert.equal(a.sha1, createHash("sha1").update(a.zip).digest("hex"));
  const names = zipEntries(a.zip);
  assert.ok(names.includes("pack.mcmeta"));
  assert.ok(names.includes("assets/sharedcosmetics/items/top_hat.json"));
  assert.ok(names.includes("assets/sharedcosmetics/models/item/top_hat.json"));
  assert.ok(names.includes("assets/sharedcosmetics/textures/item/top_hat.png"));
});

test("pack build rejects broken JSON and folders without pack.mcmeta", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  assert.throws(() => buildPack(dir), /pack\.mcmeta/);
  writeFileSync(join(dir, "pack.mcmeta"), '{"pack":{"pack_format":46,"description":""}}');
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "bad.json"), "{nope");
  assert.throws(() => buildPack(dir), /bad\.json is not valid JSON/);
});

test("api serves pack info and the zip under its hash", async () => {
  const pack = buildPack();
  const app = await buildApp({ store: new SqliteStore(":memory:"), adminToken: ADMIN, pack });

  const info = await app.inject({ method: "GET", url: "/v1/pack" });
  assert.equal(info.statusCode, 200);
  assert.deepEqual(info.json(), { sha1: pack.sha1, size: pack.zip.length, path: `/v1/pack/${pack.sha1}.zip` });

  const zip = await app.inject({ method: "GET", url: info.json().path });
  assert.equal(zip.statusCode, 200);
  assert.equal(zip.headers["content-type"], "application/zip");
  assert.equal(createHash("sha1").update(zip.rawPayload).digest("hex"), pack.sha1);

  const stale = await app.inject({ method: "GET", url: `/v1/pack/${"0".repeat(40)}.zip` });
  assert.equal(stale.statusCode, 404);
});

test("pack info points at an external host when one is configured", async () => {
  const pack = buildPack();
  const app = await buildApp({ store: new SqliteStore(":memory:"), adminToken: ADMIN, pack, packUrl: "https://cdn.example/p.zip" });
  assert.equal((await app.inject({ method: "GET", url: "/v1/pack" })).json().url, "https://cdn.example/p.zip");
});

test("pack endpoints 404 when no pack is configured", async () => {
  const app = await buildApp({ store: new SqliteStore(":memory:"), adminToken: ADMIN });
  assert.equal((await app.inject({ method: "GET", url: "/v1/pack" })).statusCode, 404);
});
