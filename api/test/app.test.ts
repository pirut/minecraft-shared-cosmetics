import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, normalizeUuid } from "../src/app.ts";
import { Store } from "../src/db.ts";

const ADMIN = "test-admin-token-123456";
const PLAYER = "069a79f444e94726a5befca90e38aaf5";
const PLAYER_DASHED = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

let app: FastifyInstance;
let serverKey: string;

const admin = { authorization: `Bearer ${ADMIN}` };
const server = () => ({ authorization: `Bearer ${serverKey}` });

beforeEach(async () => {
  app = buildApp({ store: new Store(":memory:"), adminToken: ADMIN });
  const res = await app.inject({ method: "POST", url: "/v1/servers", headers: admin, payload: { name: "test" } });
  serverKey = res.json().key;
  await app.inject({
    method: "PUT",
    url: "/v1/cosmetics/top_hat",
    headers: admin,
    payload: { name: "Top Hat", type: "HAT", data: { material: "BLACK_WOOL" } },
  });
  await app.inject({
    method: "PUT",
    url: "/v1/cosmetics/hearts",
    headers: admin,
    payload: { name: "Hearts", type: "TRAIL", data: { particle: "HEART" } },
  });
});

test("normalizes dashed and undashed uuids", () => {
  assert.equal(normalizeUuid(PLAYER), PLAYER_DASHED);
  assert.equal(normalizeUuid(PLAYER_DASHED.toUpperCase()), PLAYER_DASHED);
  assert.equal(normalizeUuid("Notch"), undefined);
});

test("catalog is public and includes slots", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/cosmetics" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().cosmetics.map((c: { id: string; slot: string }) => [c.id, c.slot]),
    [
      ["hearts", "trail"],
      ["top_hat", "head"],
    ],
  );
});

test("admin endpoints reject server keys and missing tokens", async () => {
  const noAuth = await app.inject({ method: "POST", url: "/v1/servers", payload: { name: "x" } });
  assert.equal(noAuth.statusCode, 401);
  const asServer = await app.inject({
    method: "POST",
    url: `/v1/players/${PLAYER}/grants`,
    headers: server(),
    payload: { cosmeticId: "top_hat" },
  });
  assert.equal(asServer.statusCode, 401);
});

test("player endpoints require a registered server key", async () => {
  const res = await app.inject({ method: "GET", url: `/v1/players/${PLAYER}`, headers: { authorization: "Bearer msc_nope" } });
  assert.equal(res.statusCode, 401);
});

test("cosmetics follow the player: grant, equip, read back", async () => {
  const cannotEquip = await app.inject({
    method: "PUT",
    url: `/v1/players/${PLAYER}/equipped/head`,
    headers: server(),
    payload: { cosmeticId: "top_hat" },
  });
  assert.equal(cannotEquip.statusCode, 403);

  const grant = await app.inject({
    method: "POST",
    url: `/v1/players/${PLAYER}/grants`,
    headers: admin,
    payload: { cosmeticId: "top_hat" },
  });
  assert.equal(grant.statusCode, 204);

  const wrongSlot = await app.inject({
    method: "PUT",
    url: `/v1/players/${PLAYER}/equipped/trail`,
    headers: server(),
    payload: { cosmeticId: "top_hat" },
  });
  assert.equal(wrongSlot.statusCode, 400);

  const equip = await app.inject({
    method: "PUT",
    url: `/v1/players/${PLAYER}/equipped/head`,
    headers: server(),
    payload: { cosmeticId: "top_hat" },
  });
  assert.equal(equip.statusCode, 200);

  // A second server sees the same state, keyed by the dashed uuid.
  const other = await app.inject({ method: "POST", url: "/v1/servers", headers: admin, payload: { name: "other" } });
  const profile = await app.inject({
    method: "GET",
    url: `/v1/players/${PLAYER_DASHED}`,
    headers: { authorization: `Bearer ${other.json().key}` },
  });
  assert.equal(profile.statusCode, 200);
  assert.deepEqual(profile.json().equipped, { head: "top_hat" });
  assert.deepEqual(
    profile.json().owned.map((c: { id: string }) => c.id),
    ["top_hat"],
  );

  const unequip = await app.inject({ method: "DELETE", url: `/v1/players/${PLAYER}/equipped/head`, headers: server() });
  assert.deepEqual(unequip.json().equipped, {});
});
