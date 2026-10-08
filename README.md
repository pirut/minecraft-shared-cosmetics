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
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hat models need a server resource pack; a hat's `itemModel` points at a model in that pack and falls back to its plain `material` without it.

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
| PUT | `/v1/cosmetics/:id` | admin | Create or update a cosmetic |
| POST | `/v1/servers` | admin | Register a server, returns its key once |
| GET | `/v1/servers` | admin | List servers and whether they're revoked |
| POST | `/v1/servers/:id/rotate` | admin | Issue a new key; old keys keep working for `graceSeconds` (default 86400, `0` = now) |
| DELETE | `/v1/servers/:id` | admin | Revoke a server and every key it has, permanently |
| POST | `/v1/players/:uuid/grants` | admin | Give a player a cosmetic |
| GET | `/v1/players/:uuid` | server | Owned and equipped cosmetics |
| PUT | `/v1/players/:uuid/equipped/:slot` | server | Equip an owned cosmetic |
| DELETE | `/v1/players/:uuid/equipped/:slot` | server | Unequip a slot |

Cosmetic types and their slots: `HAT` → `head`, `TRAIL` → `trail`.

**Rate limits.** Each server key gets its own bucket, because many Minecraft hosts put dozens of servers behind one IP. Calls with no key or a wrong key share a per-IP bucket, which also slows down key guessing. The admin token and `/health` are never limited. Over the limit you get `429` with a `retry-after` header. Counters live in each instance's memory, so with N instances the effective limit is up to N times higher.

**Rotating a key.** `POST /v1/servers/<id>/rotate` returns a new key. Give it to the server owner; their old key stops working after the grace period. If a key leaked, rotate with `{"graceSeconds":0}`. If a server is abusive, `DELETE /v1/servers/<id>` cuts it off for good.

Quick start once the API is running:

```sh
A="Authorization: Bearer change-me-to-something-long"
curl -X PUT localhost:8080/v1/cosmetics/pumpkin_hat -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Pumpkin Hat","type":"HAT","data":{"material":"CARVED_PUMPKIN"}}'
curl -X PUT localhost:8080/v1/cosmetics/hearts -H "$A" -H 'Content-Type: application/json' \
  -d '{"name":"Heart Trail","type":"TRAIL","data":{"particle":"HEART"}}'
curl -X POST localhost:8080/v1/servers -H "$A" -H 'Content-Type: application/json' -d '{"name":"my-server"}'
curl -X POST localhost:8080/v1/players/<uuid>/grants -H "$A" -H 'Content-Type: application/json' \
  -d '{"cosmeticId":"pumpkin_hat"}'
```

### Hosting on Fly.io

`api/Dockerfile` builds the API image and `api/fly.toml` deploys it, with a `/health` check and HTTPS forced. From `api/`:

```sh
fly launch --no-deploy --copy-config --name <your-app-name>   # creates the app from fly.toml
fly postgres create --name <your-app-name>-db                 # or point DATABASE_URL at any Postgres
fly postgres attach <your-app-name>-db                        # sets DATABASE_URL as a secret
fly secrets set ADMIN_TOKEN=$(openssl rand -base64 32)
fly deploy
```

The schema is created on first boot; several instances can start at once safely. Then set `api-url` in each server's plugin config to `https://<your-app-name>.fly.dev`.

Any other host that runs a Docker image works the same way: set `ADMIN_TOKEN`, `DATABASE_URL`, and `TRUST_PROXY=true` if it sits behind a proxy.

## Plugin (`plugin/`)

Paper 1.21.4+, Java 21.

```sh
cd plugin
./gradlew build   # jar lands in build/libs/
```

Drop the jar in `plugins/`, start once, then set `api-url` and `server-key` in `plugins/SharedCosmetics/config.yml`. In game: `/cosmetics list`, `/cosmetics equip <id>`, `/cosmetics unequip <head|trail>`.

## Not built yet

- A way for players to get cosmetics (store, achievements, admin panel). Today only the admin API grants them.
- Hosting the shared resource pack for custom models, and pushing it to players on join.
- Live sync: a change on server A shows up on server B at the player's next join, not instantly.
- Shared rate limit counters across instances (Redis) and schema migrations beyond create-if-missing.
- Hat position is tuned by `hat-offset-y` and still needs checking in game across player poses (sneaking, swimming, elytra).
