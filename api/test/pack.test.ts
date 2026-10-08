import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import { Store } from "../src/db.ts";
import { KIT_PARTS } from "../src/kit.ts";
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

test("the repo pack builds reproducibly and contains the hat kit", () => {
  const a = buildPack();
  const b = buildPack();
  assert.equal(a.sha1, b.sha1);
  assert.equal(a.sha1, createHash("sha1").update(a.zip).digest("hex"));
  const names = zipEntries(a.zip);
  assert.ok(names.includes("pack.mcmeta"));
  assert.ok(names.includes("assets/sharedcosmetics/items/kit.json"));
  assert.ok(names.includes("assets/sharedcosmetics/textures/item/kit.png"));
});

test("every kit option has a model, and the kit model only references models in the pack", () => {
  const names = new Set(zipEntries(buildPack().zip));
  const modelFile = (ref: string) => `assets/${ref.replace(":", "/models/")}.json`;
  for (const [slot, options] of Object.entries(KIT_PARTS)) {
    for (const option of options) {
      assert.ok(names.has(modelFile(`sharedcosmetics:item/kit/${slot}_${option}`)), `${slot} ${option}`);
    }
  }
  const kit = readFileSync(new URL("../../resourcepack/assets/sharedcosmetics/items/kit.json", import.meta.url), "utf8");
  for (const [, ref] of kit.matchAll(/"model": "([^"]+)"/g)) {
    assert.ok(names.has(modelFile(ref)), ref);
  }
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
  const app = buildApp({ store: new Store(":memory:"), adminToken: ADMIN, pack });

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
  const app = buildApp({ store: new Store(":memory:"), adminToken: ADMIN, pack, packUrl: "https://cdn.example/p.zip" });
  assert.equal((await app.inject({ method: "GET", url: "/v1/pack" })).json().url, "https://cdn.example/p.zip");
});

test("pack endpoints 404 when no pack is configured", async () => {
  const app = buildApp({ store: new Store(":memory:"), adminToken: ADMIN });
  assert.equal((await app.inject({ method: "GET", url: "/v1/pack" })).statusCode, 404);
});

test("hat kits are validated when a cosmetic is saved", async () => {
  const app = buildApp({ store: new Store(":memory:"), adminToken: ADMIN });
  const put = (kit: unknown) =>
    app.inject({
      method: "PUT",
      url: "/v1/cosmetics/wizard_hat",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: "Wizard Hat", type: "HAT", data: { material: "PURPLE_WOOL", kit } },
    });
  const ok = await put({ crown: "cone", brim: "wide", extra: "none", band: true, colors: ["#3b1f6b", "#e8c547"] });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().data.kit.crown, "cone");
  assert.equal((await put({ crown: "sombrero" })).statusCode, 400);
  assert.equal((await put({ colors: ["purple"] })).statusCode, 400);
  // Unknown keys are dropped rather than stored.
  assert.deepEqual((await put({ crown: "tall", size: 3 })).json().data.kit, { crown: "tall" });
});
