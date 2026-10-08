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
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hats are built from a small parts kit in the shared resource pack (`resourcepack/`), which the plugin sends to players on join. A hat is just data (which crown, brim and extras, in which colors), so new hats never change the pack. Anyone without the pack sees the hat's plain `material`.

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
| GET | `/v1/events` | server | Server-sent event stream of changes (see below) |

`/v1/events` streams a `player` event (`{uuid, owned, equipped}`) whenever a grant, equip or unequip happens, and a `catalog` event (`{id}`) when a cosmetic is created or updated, with a keep-alive comment every 25 seconds. The plugin uses it so a change on one server shows up on every other server straight away. Events fan out in-process, so this works with a single API instance; several instances would need a shared bus such as Postgres `LISTEN/NOTIFY`.

Cosmetic types and their slots: `HAT` → `head`, `TRAIL` → `trail`.

Quick start once the API is running:

```sh
A="Authorization: Bearer change-me-to-something-long"
curl -X PUT localhost:8080/v1/cosmetics/pumpkin_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Pumpkin Hat","type":"HAT","data":{"material":"CARVED_PUMPKIN"}}'
curl -X PUT localhost:8080/v1/cosmetics/top_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Top Hat","type":"HAT","data":{"material":"BLACK_WOOL","kit":{"crown":"tall","brim":"wide","band":true,"colors":["#1c1c21","#961a22"]}}}'
curl -X PUT localhost:8080/v1/cosmetics/hearts -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Heart Trail","type":"TRAIL","data":{"particle":"HEART"}}'
curl -X PUT localhost:8080/v1/cosmetics/ember_dust -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Ember Dust","type":"TRAIL","data":{"particle":"DUST_COLOR_TRANSITION","color":"#ff5500","toColor":"#330000","size":1.5,"count":3}}'
curl -X POST localhost:8080/v1/servers -H "$A" -H 'Content-Type: application/json' -d '{"name":"my-server"}'
curl -X POST localhost:8080/v1/players/<uuid>/grants -H "$A" -H 'Content-Type: application/json' \
  -d '{"cosmeticId":"pumpkin_hat"}'
```

## Resource pack (`resourcepack/`)

The pack is a fixed kit of hat parts, not one model per hat. Each part is a plain shape with a grayscale texture, and the `sharedcosmetics:kit` item model picks parts and tints them from the item's `custom_model_data` (1.21.4+). The plugin fills that in from the cosmetic's `data.kit`:

| Field | Options |
| --- | --- |
| `crown` | `tall`, `short`, `cone`, `dome`, `none` |
| `brim` | `wide`, `narrow`, `none` |
| `extra` | `ears`, `horns`, `halo`, `none` |
| `band` | `true` / `false` |
| `colors` | Up to three hex colors: crown, accent (band and extra), brim. Accent and brim default to the crown color. |

A wizard hat is `{"crown":"cone","brim":"wide","band":true,"colors":["#3b1f6b","#e8c547"]}` and a devil look is `{"crown":"none","extra":"horns","colors":["#000000","#b3121b"]}`. Neither needs a pack change. The API rejects unknown parts.

**Why a kit.** A client caches each server pack by its SHA-1 and only downloads it again when the hash changes. Every server on the network sends the same pack, so a player downloads it once for all of them. The kit makes the hash almost never change: about 15 KB, downloaded once, then cached. One model per hat would grow the pack with every hat and make every player re-download all of it each time one was added.

**Adding parts.** New shapes go in `api/scripts/gen-kit.ts` and the option lists in `api/src/kit.ts`. Run `npm run gen-kit`, commit the output, and restart the API. That changes the hash, so batch new parts. A hat that can't be built from parts can still ship its own model under `assets/`, referenced by `"itemModel": "<namespace>:<name>"` instead of `kit`.

The API zips the folder at startup and serves it at `/v1/pack/<sha1>.zip`. Servers pick up a new hash within five minutes and push it to everyone online. The zip is reproducible (stored entries, sorted, fixed timestamps), so the same assets give the same SHA-1 anywhere.

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
- Rate limiting, key revocation, and Postgres for multi-instance hosting.
- Uploading assets through the API. Today a new model means a commit to `resourcepack/` and an API restart.
- Pre-1.20.3 clients (via ViaVersion) only hold one server pack, so for them the shared pack and the server's own pack replace each other.
- The hat pose numbers are worked out from the vanilla player model and still need checking in game, elytra flight especially.
