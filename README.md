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
- **Players** reach the web page by running `/cosmetics link` in game. The server asks the API for a one-time code (8 characters, 10 minutes) and the player types it on the page, which signs them in with a 30-day cookie tied to their UUID. No Microsoft login is involved: holding the code proves you were online as that player a moment ago. On the page they can equip what they own and claim any cosmetic an admin marked as claimable.
- **Rendering** uses vanilla client features only. Hats are `ItemDisplay` entities riding the player (hidden from the wearer so they don't block the camera). Trails are particles. Custom 3D hat models need a server resource pack; a hat's `itemModel` points at a model in that pack and falls back to its plain `material` without it.

## API (`api/`)

Node 22.18+ (runs TypeScript directly), Fastify, built-in `node:sqlite`.

```sh
cd api
npm install
ADMIN_TOKEN=change-me-to-something-long npm start   # listens on :8080, writes cosmetics.db
npm test
```

Optional settings: `PUBLIC_URL` (the address players open, e.g. `https://cosmetics.example.com`; used for the link in game and to mark the cookie `Secure`), `TRUST_PROXY=1` behind a reverse proxy, `DATABASE_PATH`, `HOST`, `PORT`.

Web pages:

- `/` is the player page: enter a link code, then equip owned cosmetics and claim free ones.
- `/admin` is the admin page: paste the admin token to create and edit cosmetics, look players up by name or UUID, grant and revoke, and register servers.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/cosmetics` | none | Full catalog with render hints |
| PUT | `/v1/cosmetics/:id` | admin | Create or update a cosmetic (`claimable: true` lets players claim it) |
| POST | `/v1/servers` | admin | Register a server, returns its key once |
| GET | `/v1/servers` | admin | List registered servers |
| GET | `/v1/admin/players/:uuidOrName` | admin | Look a player up by UUID or last reported name |
| POST | `/v1/players/:uuid/grants` | admin | Give a player a cosmetic |
| DELETE | `/v1/players/:uuid/grants/:id` | admin | Take a cosmetic away (and unequip it) |
| GET | `/v1/players/:uuid?name=` | server | Owned and equipped cosmetics; `name` is remembered for admin lookup |
| POST | `/v1/players/:uuid/link-codes` | server | One-time code and URL for `/cosmetics link` |
| PUT | `/v1/players/:uuid/equipped/:slot` | server | Equip an owned cosmetic |
| DELETE | `/v1/players/:uuid/equipped/:slot` | server | Unequip a slot |
| POST | `/v1/session` | none | Exchange a link code for a session cookie |
| DELETE | `/v1/session` | cookie | Sign out |
| GET | `/v1/me` | cookie | The signed-in player's cosmetics |
| POST | `/v1/me/claims` | cookie | Claim a claimable cosmetic |
| PUT / DELETE | `/v1/me/equipped/:slot` | cookie | Equip or unequip from the web |

Cosmetic types and their slots: `HAT` → `head`, `TRAIL` → `trail`.

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

## Plugin (`plugin/`)

Paper 1.21.4+, Java 21.

```sh
cd plugin
./gradlew build   # jar lands in build/libs/
```

Drop the jar in `plugins/`, start once, then set `api-url` and `server-key` in `plugins/SharedCosmetics/config.yml`. In game: `/cosmetics list`, `/cosmetics equip <id>`, `/cosmetics unequip <head|trail>`, `/cosmetics link`.

## Not built yet

- Paid cosmetics, gift or redeem codes, and achievement unlocks. Today players get cosmetics from an admin grant or by claiming free ones on the web page.
- Hosting the shared resource pack for custom models, and pushing it to players on join.
- Live sync: a change on server A, or on the web page, shows up on server B at the player's next join, not instantly.
- Rate limiting beyond wrong link codes (which is in memory, per instance), key revocation, and Postgres for multi-instance hosting.
- Hat position is tuned by `hat-offset-y` and still needs checking in game across player poses (sneaking, swimming, elytra).
