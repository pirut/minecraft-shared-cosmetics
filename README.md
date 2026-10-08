# Minecraft Shared Cosmetics

Cosmetics that follow a player across every server that installs the plugin. A player who owns a top hat on one server sees it on every other participating server, and so does everyone around them, without installing a client mod.

## How it fits together

```
 ┌──────────────┐  server key   ┌──────────────────────┐
 │ Paper server │ ────────────▶ │  Central API (api/)  │
 │  + plugin    │ ◀──────────── │  catalog, ownership, │
 └──────────────┘   JSON/HTTPS  │  equipped slots      │
 ┌──────────────┐               │  Postgres (or SQLite)│
 │ Paper server │ ────────────▶ └──────────────────────┘
 └──────────────┘
```

- **Identity** is the player's Mojang UUID. Servers must run in `online-mode=true` (or behind a properly configured Velocity/BungeeCord proxy), otherwise anyone can claim any UUID.
- **Servers** authenticate with a per-server API key. They can read a player's cosmetics and equip or unequip ones the player already owns. Only the admin token can create cosmetics or grant them, so a rogue server can't hand out items.
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hat models come from the shared resource pack (`resourcepack/`), which the plugin sends to players on join; a hat's `itemModel` points at a model in that pack and falls back to its plain `material` for anyone without it.

## API (`api/`)

Node 22.18+ (runs TypeScript directly), Fastify. Storage is Postgres when `DATABASE_URL` is set, otherwise a local SQLite file via built-in `node:sqlite`.

```sh
cd api
npm install
ADMIN_TOKEN=change-me-to-something-long npm start   # listens on :8080, writes cosmetics.db
npm test                                            # SQLite only
TEST_DATABASE_URL=postgres://user:pass@localhost/scratch npm test   # also Postgres (wipes that database)
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | required | Admin secret, 16+ characters |
| `DATABASE_URL` | unset | `postgres://…`; use this for hosting and for more than one instance |
| `DATABASE_PATH` | `cosmetics.db` | SQLite file when `DATABASE_URL` is unset |
| `DATABASE_POOL_SIZE` | `10` | Postgres connections per instance |
| `TRUST_PROXY` | off | Set `true` behind a load balancer so per-IP limits see the real client |
| `RATE_LIMIT_SERVER_MAX` | `600` | Requests per window per server key |
| `RATE_LIMIT_ANONYMOUS_MAX` | `60` | Requests per window per IP with no valid key |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_DISABLED` | off | Set `true` to turn limits off |

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/cosmetics` | none | Full catalog with render hints |
| GET | `/v1/pack` | none | Resource pack SHA-1 and download path (or CDN `url`) |
| GET | `/v1/pack/:sha1.zip` | none | The resource pack itself |
| PUT | `/v1/cosmetics/:id` | admin | Create or update a cosmetic |
| POST | `/v1/servers` | admin | Register a server, returns its key once |
| GET | `/v1/servers` | admin | List servers and whether they're revoked |
| POST | `/v1/servers/:id/rotate` | admin | Issue a new key; old keys keep working for `graceSeconds` (default 86400, `0` = now) |
| DELETE | `/v1/servers/:id` | admin | Revoke a server and every key it has, permanently |
| POST | `/v1/players/:uuid/grants` | admin | Give a player a cosmetic |
| GET | `/v1/players/:uuid` | server | Owned and equipped cosmetics |
| PUT | `/v1/players/:uuid/equipped/:slot` | server | Equip an owned cosmetic |
| DELETE | `/v1/players/:uuid/equipped/:slot` | server | Unequip a slot |
| GET | `/v1/events` | server | Server-sent event stream of changes (see below) |

`/v1/events` streams a `player` event (`{uuid, owned, equipped}`) whenever a grant, equip or unequip happens, and a `catalog` event (`{id}`) when a cosmetic is created or updated, with a keep-alive comment every 25 seconds. The plugin uses it so a change on one server shows up on every other server straight away. Events fan out in-process, so this works with a single API instance; several instances would need a shared bus such as Postgres `LISTEN/NOTIFY`.

Cosmetic types and their slots: `HAT` → `head`, `TRAIL` → `trail`.

**Rate limits.** Each server key gets its own bucket, because many Minecraft hosts put dozens of servers behind one IP. Calls with no key or a wrong key share a per-IP bucket, which also slows down key guessing. The admin token and `/health` are never limited. Over the limit you get `429` with a `retry-after` header. Counters live in each instance's memory, so with N instances the effective limit is up to N times higher.

**Rotating a key.** `POST /v1/servers/<id>/rotate` returns a new key. Give it to the server owner; their old key stops working after the grace period. If a key leaked, rotate with `{"graceSeconds":0}`. If a server is abusive, `DELETE /v1/servers/<id>` cuts it off for good.

Quick start once the API is running:

```sh
A="Authorization: Bearer change-me-to-something-long"
curl -X PUT localhost:8080/v1/cosmetics/pumpkin_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Pumpkin Hat","type":"HAT","data":{"material":"CARVED_PUMPKIN"}}'
curl -X PUT localhost:8080/v1/cosmetics/top_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Top Hat","type":"HAT","data":{"material":"BLACK_WOOL","itemModel":"sharedcosmetics:top_hat"}}'
curl -X PUT localhost:8080/v1/cosmetics/hearts -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Heart Trail","type":"TRAIL","data":{"particle":"HEART"}}'
curl -X PUT localhost:8080/v1/cosmetics/ember_dust -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Ember Dust","type":"TRAIL","data":{"particle":"DUST_COLOR_TRANSITION","color":"#ff5500","toColor":"#330000","size":1.5,"count":3}}'
curl -X POST localhost:8080/v1/servers -H "$A" -H 'Content-Type: application/json' -d '{"name":"my-server"}'
curl -X POST localhost:8080/v1/players/<uuid>/grants -H "$A" -H 'Content-Type: application/json' \
  -d '{"cosmeticId":"pumpkin_hat"}'
```

## Resource pack (`resourcepack/`)

Every custom model lives in one shared pack under the `sharedcosmetics` namespace. To add a hat:

1. Add `assets/sharedcosmetics/items/<name>.json`, its model under `models/item/` and texture under `textures/item/` (see `top_hat`).
2. Create the cosmetic with `"itemModel": "sharedcosmetics:<name>"` and a fallback `material`.
3. Restart the API. It zips the folder at startup and serves it at `/v1/pack/<sha1>.zip`.

Servers pick up the new hash within five minutes and push it to everyone online; the client only re-downloads when the hash changes. The zip is reproducible (stored entries, sorted, fixed timestamps), so the same assets give the same SHA-1 anywhere.

**Hosting.** By default the API serves the pack itself. To put it on a CDN or static host instead, run `npm run build-pack` in `api/`, upload `dist/sharedcosmetics-<sha1>.zip`, and start the API with `PACK_URL` set to its public URL. The API still builds the pack from the same folder to know the hash, so deploy the API and the upload from the same commit. `PACK_DIR` points the API at a different folder.

**Servers that already send a resource pack.** Minecraft 1.20.3+ clients hold several server packs at once, keyed by id. The plugin sends the shared pack under its own fixed id with `replace: false`, so it lands next to the pack from `server.properties` or another plugin instead of replacing it, and both stay loaded. Nothing collides because every shared file is under `assets/sharedcosmetics/`. The admin doesn't need to do anything.

If you'd rather players get a single download, set `resource-pack.enabled: false` in the plugin config and copy `resourcepack/assets/sharedcosmetics/` into your own pack. You then need to re-merge when the shared pack changes, or new hats show as their fallback item.

The pack is optional by default (`resource-pack.required: false`): players who decline it still see hats, as the plain fallback item. Download failures (unreachable URL, hash mismatch) are logged on the server.

## Hosting on Fly.io

`api/Dockerfile` builds the API image (with the resource pack baked in) and `fly.toml` deploys it, with a `/health` check and HTTPS forced. From the repo root:

```sh
fly launch --no-deploy --copy-config --name <your-app-name>   # creates the app from fly.toml
fly postgres create --name <your-app-name>-db                 # or point DATABASE_URL at any Postgres
fly postgres attach <your-app-name>-db                        # sets DATABASE_URL as a secret
fly secrets set ADMIN_TOKEN=$(openssl rand -base64 32)
fly deploy
fly scale count 1                                             # see the note below on instances
```

The schema is created on first boot. Run one machine for now: live sync (`/v1/events`) fans out within a single API process, so with several instances a server only hears changes made through the instance it's connected to. Then set `api-url` in each server's plugin config to `https://<your-app-name>.fly.dev`.

Any other host that runs a Docker image works the same way (`docker build -f api/Dockerfile .` from the repo root): set `ADMIN_TOKEN`, `DATABASE_URL`, and `TRUST_PROXY=true` if it sits behind a proxy.

## Plugin (`plugin/`)

Paper 1.21.4+, Java 21.

```sh
cd plugin
./gradlew build   # jar lands in build/libs/
```

Drop the jar in `plugins/`, start once, then set `api-url` and `server-key` in `plugins/SharedCosmetics/config.yml`. In game: `/cosmetics list`, `/cosmetics equip <id>`, `/cosmetics unequip <head|trail>`.

**Live sync.** With `live-sync: true` (the default) the plugin keeps the `/v1/events` stream open, so equipping a hat on server A puts it on the player's head on server B (and in front of everyone there) right away. If the connection drops it reconnects with backoff and re-fetches every online player, so nothing missed while it was down is lost.

**Velocity and BungeeCord.** Install the plugin on every backend server, not on the proxy; backends on one network can share a server key. Cosmetics are keyed by Mojang account UUIDs, so the plugin only serves players whose UUID is a real Mojang one (version 4). That means it works on online-mode servers and behind an online-mode proxy with forwarding (Velocity modern forwarding, or BungeeCord with `settings.bungeecord: true`), and it stays off for offline-mode players and Bedrock players from Floodgate rather than letting them read or change someone else's cosmetics. The plugin logs at startup if the setup means players will be skipped. With BungeeCord forwarding, firewall the backends so only the proxy can reach them, or anyone can spoof a UUID.

**Hats** follow the player's pose: they tilt with the head, drop when sneaking, and move to the front of the body when swimming, crawling or flying with an elytra. They hide while sleeping and during riptide spins, and keep working while riding. The numbers come from the vanilla player model and can be tuned under `hat:` in `config.yml`.

**Trails** can use any particle, including ones that need extra data. Keys in the cosmetic's `data`:

| Key | Used by | Example |
| --- | --- | --- |
| `particle` | all | `"HEART"`, `"DUST"` |
| `count` | all (1 to 20, default 1) | `3` |
| `color`, `toColor` | `DUST`, `DUST_COLOR_TRANSITION`, `ENTITY_EFFECT` | `"#ff5500"` |
| `size` | dust (0.01 to 4, default 1) | `1.5` |
| `block` | `BLOCK`, `FALLING_DUST`, `DUST_PILLAR`, `BLOCK_MARKER` | `"minecraft:cherry_leaves"` |
| `item` | `ITEM` | `"DIAMOND"` |
| `value` | `SCULK_CHARGE` (roll), `SHRIEK` (delay) | `0.5` |

A trail with bad data logs one warning and is skipped.

## Not built yet

- A way for players to get cosmetics (store, achievements, admin panel). Today only the admin API grants them.
- Running more than one API instance: live sync needs a shared bus (Postgres LISTEN/NOTIFY) and rate limit counters need a shared store (Redis). Schema migrations are create-if-missing only.
- Uploading assets through the API. Today a new model means a commit to `resourcepack/` and an API restart.
- Pre-1.20.3 clients (via ViaVersion) only hold one server pack, so for them the shared pack and the server's own pack replace each other.
- The hat pose numbers are worked out from the vanilla player model and still need checking in game, elytra flight especially.
