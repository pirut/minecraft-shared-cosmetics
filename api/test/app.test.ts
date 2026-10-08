import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp, normalizeUuid, type AppOptions } from "../src/app.ts";
import type { Store } from "../src/db.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { SqliteStore } from "../src/sqlite-store.ts";

const ADMIN = "test-admin-token-123456";
const PLAYER = "069a79f444e94726a5befca90e38aaf5";
const PLAYER_DASHED = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

const admin = { authorization: `Bearer ${ADMIN}` };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

test("normalizes dashed and undashed uuids", () => {
  assert.equal(normalizeUuid(PLAYER), PLAYER_DASHED);
  assert.equal(normalizeUuid(PLAYER_DASHED.toUpperCase()), PLAYER_DASHED);
  assert.equal(normalizeUuid("Notch"), undefined);
});

interface Backend {
  name: string;
  /** Returns a store with no data in it. */
  fresh(): Promise<Store>;
  done(): Promise<void>;
}

const sqlite: Backend = {
  name: "sqlite",
  fresh: async () => new SqliteStore(":memory:"),
  done: async () => {},
};

// Postgres runs when TEST_DATABASE_URL points at a database the tests may wipe.
function postgres(url: string): Backend {
  let store: PostgresStore | undefined;
  return {
    name: "postgres",
    async fresh() {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      // First run drops whatever schema was there so the store recreates the current one.
      await client.query(
        store
          ? "TRUNCATE equipped, ownership, server_keys, servers, cosmetics, players, link_codes, web_sessions"
          : "DROP TABLE IF EXISTS equipped, ownership, server_keys, servers, cosmetics, players, link_codes, web_sessions",
      );
      await client.end();
      store ??= await PostgresStore.connect(url);
      return store;
    },
    done: async () => store?.close(),
  };
}

const backends = [sqlite, ...(process.env.TEST_DATABASE_URL ? [postgres(process.env.TEST_DATABASE_URL)] : [])];

for (const backend of backends) {
  describe(backend.name, () => {
    let app: FastifyInstance;
    let store: Store;
    let serverKey: string;
    let serverId: string;
    const server = () => bearer(serverKey);

    const build = (extra: Partial<AppOptions> = {}) => buildApp({ store, adminToken: ADMIN, rateLimit: false, ...extra });

    after(() => backend.done());

    beforeEach(async () => {
      store = await backend.fresh();
      app = await build();
      const res = await app.inject({ method: "POST", url: "/v1/servers", headers: admin, payload: { name: "test" } });
      serverKey = res.json().key;
      serverId = res.json().id;
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
        headers: bearer(other.json().key),
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

    const playerStatus = async (key: string) =>
      (await app.inject({ method: "GET", url: `/v1/players/${PLAYER}`, headers: bearer(key) })).statusCode;

    test("admin can list servers", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/servers", headers: admin });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(
        res.json().servers.map((s: { id: string; name: string; revokedAt: string | null }) => [s.id, s.name, s.revokedAt]),
        [[serverId, "test", null]],
      );
      const asServer = await app.inject({ method: "GET", url: "/v1/servers", headers: server() });
      assert.equal(asServer.statusCode, 401);
    });

    test("rotating with no grace kills the old key at once", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/servers/${serverId}/rotate`,
        headers: admin,
        payload: { graceSeconds: 0 },
      });
      assert.equal(res.statusCode, 200);
      const newKey = res.json().key;
      assert.notEqual(newKey, serverKey);
      assert.equal(await playerStatus(serverKey), 401);
      assert.equal(await playerStatus(newKey), 200);
    });

    test("rotating keeps the old key alive for the grace period", async () => {
      const res = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/rotate`, headers: admin });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().oldKeysExpireInSeconds, 86400);
      assert.equal(await playerStatus(serverKey), 200);
      assert.equal(await playerStatus(res.json().key), 200);

      // A second rotation with no grace cuts off both earlier keys.
      const again = await app.inject({
        method: "POST",
        url: `/v1/servers/${serverId}/rotate`,
        headers: admin,
        payload: { graceSeconds: 0 },
      });
      assert.equal(await playerStatus(serverKey), 401);
      assert.equal(await playerStatus(res.json().key), 401);
      assert.equal(await playerStatus(again.json().key), 200);
    });

    test("rotation rejects unknown servers and silly grace periods", async () => {
      const unknown = await app.inject({ method: "POST", url: "/v1/servers/nope/rotate", headers: admin });
      assert.equal(unknown.statusCode, 404);
      const tooLong = await app.inject({
        method: "POST",
        url: `/v1/servers/${serverId}/rotate`,
        headers: admin,
        payload: { graceSeconds: 365 * 86400 },
      });
      assert.equal(tooLong.statusCode, 400);
    });

    test("revoking a server cuts off every key and blocks rotation", async () => {
      const rotated = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/rotate`, headers: admin });
      const revoke = await app.inject({ method: "DELETE", url: `/v1/servers/${serverId}`, headers: admin });
      assert.equal(revoke.statusCode, 204);
      assert.equal(await playerStatus(serverKey), 401);
      assert.equal(await playerStatus(rotated.json().key), 401);

      const rotateAfter = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/rotate`, headers: admin });
      assert.equal(rotateAfter.statusCode, 404);
      const list = await app.inject({ method: "GET", url: "/v1/servers", headers: admin });
      assert.ok(list.json().servers[0].revokedAt);

      const unknown = await app.inject({ method: "DELETE", url: "/v1/servers/nope", headers: admin });
      assert.equal(unknown.statusCode, 404);
    });

    test("rate limits each server key separately and anonymous callers by ip", async () => {
      app = await build({ rateLimit: { serverMax: 3, anonymousMax: 2, windowMs: 60_000 } });
      const other = await app.inject({ method: "POST", url: "/v1/servers", headers: admin, payload: { name: "other" } });
      const otherKey = other.json().key;

      for (let i = 0; i < 3; i++) assert.equal(await playerStatus(serverKey), 200);
      const limited = await app.inject({ method: "GET", url: `/v1/players/${PLAYER}`, headers: server() });
      assert.equal(limited.statusCode, 429);
      assert.ok(limited.headers["retry-after"]);
      // Same IP, different key: its own bucket.
      assert.equal(await playerStatus(otherKey), 200);

      // Guessing keys counts against the caller's IP.
      assert.equal(await playerStatus("msc_guess1"), 401);
      assert.equal(await playerStatus("msc_guess2"), 401);
      assert.equal(await playerStatus("msc_guess3"), 429);
      assert.equal((await app.inject({ method: "GET", url: "/v1/cosmetics" })).statusCode, 429);

      // The admin is never limited, and neither is the health check.
      for (let i = 0; i < 5; i++) {
        assert.equal((await app.inject({ method: "GET", url: "/v1/servers", headers: admin })).statusCode, 200);
      }
      assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    });

    const linkCode = async (name = "Notch") => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/players/${PLAYER}/link-codes`,
        headers: server(),
        payload: { name },
      });
      assert.equal(res.statusCode, 201);
      return res.json() as { code: string; url: string };
    };

    const signIn = async (code: string) => {
      const res = await app.inject({ method: "POST", url: "/v1/session", payload: { code } });
      const setCookie = String(res.headers["set-cookie"] ?? "");
      return { res, cookie: setCookie.split(";")[0] };
    };

    test("link codes are issued only to servers", async () => {
      const res = await app.inject({ method: "POST", url: `/v1/players/${PLAYER}/link-codes`, payload: {} });
      assert.equal(res.statusCode, 401);
      const { code, url } = await linkCode();
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.ok(url.endsWith(`/?code=${code}`));
    });

    test("a link code signs the player in once, in any case or format", async () => {
      const { code } = await linkCode();
      const { res, cookie } = await signIn(code.toLowerCase().replace("-", " "));
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().uuid, PLAYER_DASHED);
      assert.equal(res.json().name, "Notch");
      assert.match(String(res.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);

      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().uuid, PLAYER_DASHED);

      const reused = await signIn(code);
      assert.equal(reused.res.statusCode, 400);

      const logout = await app.inject({ method: "DELETE", url: "/v1/session", headers: { cookie } });
      assert.equal(logout.statusCode, 204);
      const after = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
      assert.equal(after.statusCode, 401);
    });

    test("a new link code replaces the previous one", async () => {
      const first = await linkCode();
      await linkCode();
      assert.equal((await signIn(first.code)).res.statusCode, 400);
    });

    test("wrong codes are rate limited per address", async () => {
      for (let i = 0; i < 10; i++) assert.equal((await signIn("AAAA-AAAA")).res.statusCode, 400);
      const { code } = await linkCode();
      assert.equal((await signIn(code)).res.statusCode, 429);
    });

    test("players claim claimable cosmetics and equip them from the web", async () => {
      await app.inject({
        method: "PUT",
        url: "/v1/cosmetics/hearts",
        headers: admin,
        payload: { name: "Hearts", type: "TRAIL", claimable: true, data: { particle: "HEART" } },
      });
      const { cookie } = await signIn((await linkCode()).code);

      const notClaimable = await app.inject({
        method: "POST",
        url: "/v1/me/claims",
        headers: { cookie },
        payload: { cosmeticId: "top_hat" },
      });
      assert.equal(notClaimable.statusCode, 403);

      const claim = await app.inject({ method: "POST", url: "/v1/me/claims", headers: { cookie }, payload: { cosmeticId: "hearts" } });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(
        claim.json().owned.map((c: { id: string }) => c.id),
        ["hearts"],
      );

      const equip = await app.inject({
        method: "PUT",
        url: "/v1/me/equipped/trail",
        headers: { cookie },
        payload: { cosmeticId: "hearts" },
      });
      assert.deepEqual(equip.json().equipped, { trail: "hearts" });

      // Servers see the web change.
      const seen = await app.inject({ method: "GET", url: `/v1/players/${PLAYER}`, headers: server() });
      assert.deepEqual(seen.json().equipped, { trail: "hearts" });

      const unequip = await app.inject({ method: "DELETE", url: "/v1/me/equipped/trail", headers: { cookie } });
      assert.deepEqual(unequip.json().equipped, {});
    });

    test("web endpoints need a session", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/me/claims", payload: { cosmeticId: "hearts" } });
      assert.equal(res.statusCode, 401);
    });

    test("admins find players by reported name, grant and revoke", async () => {
      await app.inject({ method: "GET", url: `/v1/players/${PLAYER}?name=Notch`, headers: server() });
      const asServer = await app.inject({ method: "GET", url: "/v1/admin/players/notch", headers: server() });
      assert.equal(asServer.statusCode, 401);
      const found = await app.inject({ method: "GET", url: "/v1/admin/players/notch", headers: admin });
      assert.equal(found.statusCode, 200);
      assert.equal(found.json().uuid, PLAYER_DASHED);
      const missing = await app.inject({ method: "GET", url: "/v1/admin/players/jeb_", headers: admin });
      assert.equal(missing.statusCode, 404);

      await app.inject({ method: "POST", url: `/v1/players/${PLAYER}/grants`, headers: admin, payload: { cosmeticId: "top_hat" } });
      await app.inject({ method: "PUT", url: `/v1/players/${PLAYER}/equipped/head`, headers: server(), payload: { cosmeticId: "top_hat" } });
      const revoke = await app.inject({ method: "DELETE", url: `/v1/players/${PLAYER}/grants/top_hat`, headers: admin });
      assert.equal(revoke.statusCode, 204);
      const after = await app.inject({ method: "GET", url: `/v1/admin/players/${PLAYER}`, headers: admin });
      assert.deepEqual(after.json().owned, []);
      assert.deepEqual(after.json().equipped, {});

      const servers = await app.inject({ method: "GET", url: "/v1/servers", headers: admin });
      assert.deepEqual(
        servers.json().servers.map((s: { name: string }) => s.name),
        ["test"],
      );
    });

    test("serves the player and admin pages", async () => {
      for (const url of ["/", "/admin"]) {
        const res = await app.inject({ method: "GET", url });
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers["content-type"]), /text\/html/);
      }
    });

    test("event stream pushes player and catalog changes to other servers", async () => {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const { port } = app.server.address() as { port: number };
      try {
        const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/events`);
        assert.equal(unauthorized.status, 401);

        const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: server() });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        const nextEvent = async (): Promise<{ event: string; data: unknown }> => {
          for (;;) {
            const end = buffered.indexOf("\n\n");
            if (end >= 0) {
              const block = buffered.slice(0, end);
              buffered = buffered.slice(end + 2);
              const event = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (event && data) return { event, data: JSON.parse(data) };
              continue; // comment (connected / ping)
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream ended");
            buffered += value;
          }
        };

        await app.inject({ method: "POST", url: `/v1/players/${PLAYER}/grants`, headers: admin, payload: { cosmeticId: "top_hat" } });
        assert.deepEqual(await nextEvent(), {
          event: "player",
          data: { type: "player", uuid: PLAYER_DASHED, owned: ["top_hat"], equipped: {} },
        });

        await app.inject({ method: "PUT", url: `/v1/players/${PLAYER}/equipped/head`, headers: server(), payload: { cosmeticId: "top_hat" } });
        assert.deepEqual(await nextEvent(), {
          event: "player",
          data: { type: "player", uuid: PLAYER_DASHED, owned: ["top_hat"], equipped: { head: "top_hat" } },
        });

        await app.inject({ method: "PUT", url: "/v1/cosmetics/red_dust", headers: admin, payload: { name: "Red Dust", type: "TRAIL", data: { particle: "DUST", color: "#ff0000" } } });
        assert.deepEqual(await nextEvent(), { event: "catalog", data: { type: "catalog", id: "red_dust" } });

        await reader.cancel();
      } finally {
        await app.close();
      }
    });
  });
}
