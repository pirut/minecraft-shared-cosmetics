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
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hat models need a server resource pack; a hat's `itemModel` points at a model in that pack and falls back to its plain `material` without it.

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
curl -X PUT localhost:8080/v1/cosmetics/hearts -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Heart Trail","type":"TRAIL","data":{"particle":"HEART"}}'
curl -X PUT localhost:8080/v1/cosmetics/ember_dust -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Ember Dust","type":"TRAIL","data":{"particle":"DUST_COLOR_TRANSITION","color":"#ff5500","toColor":"#330000","size":1.5,"count":3}}'
curl -X POST localhost:8080/v1/servers -H "$A" -H 'Content-Type: application/json' -d '{"name":"my-server"}'
curl -X POST localhost:8080/v1/players/<uuid>/grants -H "$A" -H 'Content-Type: application/json' \
  -d '{"cosmeticId":"pumpkin_hat"}'
```

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
- Hosting the shared resource pack for custom models, and pushing it to players on join.
- Rate limiting, key revocation, and Postgres for multi-instance hosting.
- The hat pose numbers are worked out from the vanilla player model and still need checking in game, elytra flight especially.
