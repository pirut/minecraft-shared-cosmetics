import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { storedZip } from "../src/pack.ts";

const ADMIN = "test-admin-token-123456";
const admin = { authorization: `Bearer ${ADMIN}` };
const ALEX = "069a79f444e94726a5befca90e38aaf5";
const STEVE = "853c80ef-3c37-49fd-aa49-938b674adae6";

const bundle = (files: Record<string, string>) =>
  storedZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
const WINGS = bundle({ "geometry.json": "{}", "texture.png": "png", "animations.json": "{}" });

let app: FastifyInstance;
let store: SqliteStore;

const upload = (zip: Buffer) =>
  app.inject({ method: "PUT", url: "/v1/assets", headers: { ...admin, "content-type": "application/zip" }, payload: zip });

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  app = await buildApp({ store, adminToken: ADMIN, rateLimit: false });
});

test("bundles upload under their sha256 and download unchanged", async () => {
  const res = await upload(WINGS);
  assert.equal(res.statusCode, 201);
  const id = createHash("sha256").update(WINGS).digest("hex");
  assert.deepEqual(res.json(), { id, size: WINGS.length });

  const got = await app.inject({ method: "GET", url: `/v1/assets/${id}` });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.ok(got.rawPayload.equals(WINGS));
  assert.equal((await app.inject({ method: "GET", url: `/v1/assets/${"0".repeat(64)}` })).statusCode, 404);
});

test("bundle uploads need the admin token and a valid structure", async () => {
  const anon = await app.inject({ method: "PUT", url: "/v1/assets", headers: { "content-type": "application/zip" }, payload: WINGS });
  assert.equal(anon.statusCode, 401);
  const cases: [Buffer, RegExp][] = [
    [Buffer.from("not a zip"), /not a zip/],
    [bundle({ "geometry.json": "{}" }), /missing texture\.png/],
    [bundle({ "geometry.json": "{}", "texture.png": "png", "run.sh": "rm -rf /" }), /unexpected file "run\.sh"/],
    [bundle({ "geometry.json": "{}", "texture.png": "png", "../texture.png": "png" }), /unexpected file/],
  ];
  for (const [zip, error] of cases) {
    const res = await upload(zip);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, error);
  }
});

test("cosmetics can carry a model, but only for an uploaded bundle", async () => {
  const id = (await upload(WINGS)).json().id;
  const put = (model: unknown) =>
    app.inject({
      method: "PUT",
      url: "/v1/cosmetics/phoenix_wings",
      headers: admin,
      payload: { name: "Phoenix Wings", type: "BACK", data: { model } },
    });
  const ok = await put({ bundle: id, bone: "body", animations: ["idle", "flap"] });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().slot, "back");
  assert.equal((await put({ bundle: "f".repeat(64), bone: "body" })).statusCode, 400);
  assert.equal((await put({ bundle: id, bone: "tail" })).statusCode, 400);
});

test("anyone can look up what a batch of players has equipped", async () => {
  await store.upsertCosmetic({ id: "top_hat", name: "Top Hat", type: "HAT", claimable: false, data: {} });
  await store.upsertCosmetic({ id: "hearts", name: "Hearts", type: "TRAIL", claimable: false, data: {} });
  await store.grant("069a79f4-44e9-4726-a5be-fca90e38aaf5", "top_hat");
  await store.grant("069a79f4-44e9-4726-a5be-fca90e38aaf5", "hearts");
  await store.equip("069a79f4-44e9-4726-a5be-fca90e38aaf5", "head", "top_hat");
  await store.equip("069a79f4-44e9-4726-a5be-fca90e38aaf5", "trail", "hearts");

  const res = await app.inject({ method: "POST", url: "/v1/equipped", payload: { players: [ALEX, STEVE, "Notch", ALEX] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    players: { "069a79f4-44e9-4726-a5be-fca90e38aaf5": { head: "top_hat", trail: "hearts" } },
  });

  const tooMany = Array.from({ length: 101 }, () => STEVE);
  assert.equal((await app.inject({ method: "POST", url: "/v1/equipped", payload: { players: tooMany } })).statusCode, 400);
});

test("the example phoenix wings bundle is a valid upload", async () => {
  const dir = new URL("../../examples/phoenix_wings/", import.meta.url);
  const files = ["animations.json", "geometry.json", "texture.png"];
  const zip = storedZip(files.map((name) => ({ name, data: readFileSync(new URL(name, dir)) })));
  const res = await upload(zip);
  assert.equal(res.statusCode, 201);
});
