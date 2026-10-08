# Client mod design

Status: steps 1 to 3 below are built (API, mod, bundle loader and renderer, with an example bundle in `examples/phoenix_wings/`); 4 and 5 are planned. The plugin and parts kit stay as the vanilla fallback; the mod adds a full-fidelity renderer for players who install it.

## Goal

Cosmetics that vanilla can't draw: animated wings, pets that follow you, auras, capes, backpacks, full Blockbench models with their own textures and animations. They follow the player across every server, including servers that don't run the plugin.

## Shape of it

```
 Fabric client mod ──GET equipped(uuids)──▶ Central API ◀── Paper plugin (fallback renderer)
        │                                       │
        └──GET /v1/assets/<sha256>  ◀── content-addressed model bundles (CDN-friendly)
```

- **The mod renders, the server doesn't have to.** For every player the client can see, the mod asks the API what they have equipped (batched, cached for a minute) and draws it on that player's model. That works on any server, plugin or not.
- **The plugin keeps vanilla players covered.** When a cosmetic has a `kit` recipe, the plugin still draws that simpler version for everyone. Modded clients hide the plugin's display entities (they carry a marker tag) and draw the full model instead, so nobody sees both.

## Cosmetic format

Each cosmetic in the catalog gains an optional `model` next to the existing fallback data:

```json
{
  "id": "phoenix_wings", "type": "BACK",
  "data": {
    "model": { "bundle": "9f2c…", "bone": "body", "animations": ["idle", "flap"] }
  }
}
```

Cosmetics with a vanilla equivalent also keep their `kit` or `material`, so the plugin can still draw something. Ones that only make sense modded, like wings, leave it out, and vanilla players simply don't see them.

A **bundle** is one small zip exported from Blockbench: `geometry.json` (Bedrock entity format, box UV), `texture.png` and optionally `animations.json`. Bundles are named by the hex SHA-256 of their bytes, so they never change once published. Any CDN can cache them forever, and the client caches them on disk the same way.

New slots come with this: `back` (wings, capes, backpacks), `pet` (follows at the shoulder), `aura` (particles and shader-free glow meshes around the body), alongside `head` and `trail`.

## Downloads

Nothing is downloaded up front. The first time a player near you wears a cosmetic, the client fetches that one bundle (typically 5 to 50 KB), verifies its hash and caches it. After that it's free. A player who never meets anyone with wings never downloads wings. No resource reload happens, because the mod renders bundles itself instead of going through resource packs.

## Rendering

- A Fabric `FeatureRenderer` on the player model, so cosmetics attach to the real head, body and arm bones and follow sneaking, swimming, elytra and emotes exactly.
- A small built-in animator (no GeckoLib dependency) that plays the cosmetic's listed clips on a loop from numeric keyframes. Next: keying clips to movement, so wings flap faster when sprinting and pets idle when you stand still.
- A per-client limit on how many animated cosmetics render at once, and a distance cutoff, so a crowded lobby stays smooth.
- Options screen: hide all, hide others', hide specific slots.

## API additions

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/equipped` | none | Body: up to 100 UUIDs. Returns equipped cosmetic ids per player. Public, because equipped cosmetics are visible to anyone who can see the player anyway. |
| GET | `/v1/assets/:sha256` | none | A model bundle, immutable caching. |
| PUT | `/v1/assets` | admin | Upload a bundle (`application/zip`); the server checks its size and that it holds only `geometry.json`, `texture.png` and optionally `animations.json`. |
| POST | `/v1/session` | Mojang | Lets the mod itself equip cosmetics from an in-game menu. The mod proves who the player is the same way joining a server does (`hasJoined` against Mojang's session server), and gets a short-lived token scoped to that one player. |

## Safety

- Bundles are uploaded only by admins and validated server-side: size cap, known file types, geometry and texture limits. The client re-checks the hash and the same limits before loading anything.
- The client only ever parses geometry, PNG and animation JSON. Bundles can't contain code.
- Rate limits on the public lookup, and the client batches and caches so a server full of modded players makes few requests.

## Build order

1. API: `/v1/equipped` batch lookup, asset storage and the `model` field. Small, testable now.
2. Mod skeleton: Fabric for the plugin's minimum (1.21.4), fetches equipped cosmetics for visible players and draws a placeholder cube on the right bone. Proves the plumbing.
3. Bundle loader and renderer with one real cosmetic (animated wings).
4. In-game equip menu with Mojang session auth.
5. Plugin marker tag so modded clients hide the vanilla fallback.
