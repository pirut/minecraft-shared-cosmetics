# Minecraft Shared Cosmetics

Cosmetics that follow a player across every server that installs the plugin. A player who owns a top hat on one server sees it on every other participating server, and so does everyone around them, without installing a client mod.

## How it fits together

```
 ┌──────────────┐  server key   ┌──────────────────────┐
 │ Paper server │ ────────────▶ │  Central API (api/)  │
 │  + plugin    │ ◀──────────── │  catalog, ownership, │
 └──────────────┘   JSON/HTTPS  │  equipped slots      │
 ┌──────────────┐               │  (SQLite for now)    │
 │ Paper server │ ────────────▶ └──────────────────────┘
 └──────────────┘
```

- **Identity** is the player's Mojang UUID. Servers must run in `online-mode=true` (or behind a properly configured Velocity/BungeeCord proxy), otherwise anyone can claim any UUID.
- **Servers** authenticate with a per-server API key. They can read a player's cosmetics and equip or unequip ones the player already owns. Only the admin token can create cosmetics or grant them, so a rogue server can't hand out items.
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hat models come from the shared resource pack (`resourcepack/`), which the plugin sends to players on join; a hat's `itemModel` points at a model in that pack and falls back to its plain `material` for anyone without it.

## API (`api/`)

Node 22.18+ (runs TypeScript directly), Fastify, built-in `node:sqlite`.

```sh
cd api
npm install
ADMIN_TOKEN=change-me-to-something-long npm start   # listens on :8080, writes cosmetics.db
npm test
```

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/cosmetics` | none | Full catalog with render hints |
| GET | `/v1/pack` | none | Resource pack SHA-1 and download path (or CDN `url`) |
| GET | `/v1/pack/:sha1.zip` | none | The resource pack itself |
| PUT | `/v1/cosmetics/:id` | admin | Create or update a cosmetic |
| POST | `/v1/servers` | admin | Register a server, returns its key once |
| POST | `/v1/players/:uuid/grants` | admin | Give a player a cosmetic |
| GET | `/v1/players/:uuid` | server | Owned and equipped cosmetics |
| PUT | `/v1/players/:uuid/equipped/:slot` | server | Equip an owned cosmetic |
| DELETE | `/v1/players/:uuid/equipped/:slot` | server | Unequip a slot |

Cosmetic types and their slots: `HAT` → `head`, `TRAIL` → `trail`.

Quick start once the API is running:

```sh
A="Authorization: Bearer change-me-to-something-long"
curl -X PUT localhost:8080/v1/cosmetics/pumpkin_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Pumpkin Hat","type":"HAT","data":{"material":"CARVED_PUMPKIN"}}'
curl -X PUT localhost:8080/v1/cosmetics/top_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Top Hat","type":"HAT","data":{"material":"BLACK_WOOL","itemModel":"sharedcosmetics:top_hat"}}'
curl -X PUT localhost:8080/v1/cosmetics/hearts -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Heart Trail","type":"TRAIL","data":{"particle":"HEART"}}'
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

## Plugin (`plugin/`)

Paper 1.21.4+, Java 21.

```sh
cd plugin
./gradlew build   # jar lands in build/libs/
```

Drop the jar in `plugins/`, start once, then set `api-url` and `server-key` in `plugins/SharedCosmetics/config.yml`. In game: `/cosmetics list`, `/cosmetics equip <id>`, `/cosmetics unequip <head|trail>`.

## Not built yet

- A way for players to get cosmetics (store, achievements, admin panel). Today only the admin API grants them.
- Live sync: a change on server A shows up on server B at the player's next join, not instantly.
- Rate limiting, key revocation, and Postgres for multi-instance hosting.
- Uploading assets through the API. Today a new model means a commit to `resourcepack/` and an API restart.
- Pre-1.20.3 clients (via ViaVersion) only hold one server pack, so for them the shared pack and the server's own pack replace each other.
- Hat position is tuned by `hat-offset-y` and still needs checking in game across player poses (sneaking, swimming, elytra).
