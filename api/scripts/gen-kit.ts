// Regenerates the hat kit in resourcepack/: one tintable part model per option, plus the
// item definition that picks parts and colors from an item's custom_model_data.
// Usage: npm run gen-kit   (edit the parts below, then commit the output)
import { mkdirSync, writeFileSync } from "node:fs";
import { KIT_PARTS } from "../src/kit.ts";

const root = process.env.PACK_DIR ?? new URL("../../resourcepack", import.meta.url).pathname;
const M = `${root}/assets/sharedcosmetics/models/item/kit`;
mkdirSync(M, { recursive: true });
// No uv: the game maps the texture from each element's own bounds.
const face = { texture: "#kit", tintindex: 0 };
const box = (from: number[], to: number[]) => ({ from, to, faces: Object.fromEntries(["north", "south", "east", "west", "up", "down"].map((f) => [f, face])) });
// Coordinates are in model pixels; the top of the wearer's head is at y = 12.
const parts: Record<string, ReturnType<typeof box>[]> = {
  brim_wide: [box([1, 12, 1], [15, 13, 15])],
  brim_narrow: [box([3, 12, 3], [13, 12.75, 13])],
  crown_tall: [box([4.5, 13, 4.5], [11.5, 21, 11.5])],
  crown_short: [box([4.5, 13, 4.5], [11.5, 17, 11.5])],
  crown_cone: [box([4.5, 13, 4.5], [11.5, 16, 11.5]), box([5.5, 16, 5.5], [10.5, 19, 10.5]), box([6.75, 19, 6.75], [9.25, 22, 9.25])],
  crown_dome: [box([4.5, 13, 4.5], [11.5, 15.5, 11.5]), box([5.5, 15.5, 5.5], [10.5, 17, 10.5])],
  band: [box([4.4, 13, 4.4], [11.6, 14.5, 11.6])],
  extra_ears: [box([4, 12, 7], [6, 15, 9]), box([10, 12, 7], [12, 15, 9])],
  extra_horns: [box([3, 12, 7], [4.5, 15, 8.5]), box([2.5, 15, 7.25], [3.75, 17.5, 8.25]), box([11.5, 12, 7], [13, 15, 8.5]), box([12.25, 15, 7.25], [13.5, 17.5, 8.25])],
  extra_halo: [box([4, 22.5, 4], [12, 23, 5]), box([4, 22.5, 11], [12, 23, 12]), box([4, 22.5, 5], [5, 23, 11]), box([11, 22.5, 5], [12, 23, 11])],
};
for (const [name, elements] of Object.entries(parts)) {
  const lines = elements.map((e) => `    ${JSON.stringify(e)}`).join(",\n");
  const textures = JSON.stringify({ particle: "sharedcosmetics:item/kit", kit: "sharedcosmetics:item/kit" });
  writeFileSync(`${M}/${name}.json`, `{\n  "textures": ${textures},\n  "elements": [\n${lines}\n  ]\n}\n`);
}
// strings[0] crown, strings[1] brim, strings[2] extra; flags[0] band; colors[0] crown, [1] accent, [2] brim.
const part = (name: string, color: number) => ({
  type: "minecraft:model",
  model: `sharedcosmetics:item/kit/${name}`,
  tints: [{ type: "minecraft:custom_model_data", index: color, default: 16777215 }],
});
const select = (index: number, prefix: string, options: string[], color: number) => ({
  type: "minecraft:select",
  property: "minecraft:custom_model_data",
  index,
  cases: options.map((o) => ({ when: o, model: part(`${prefix}_${o}`, color) })),
  fallback: { type: "minecraft:empty" },
});
const item = {
  model: {
    type: "minecraft:composite",
    models: [
      select(0, "crown", [...KIT_PARTS.crown], 0),
      select(1, "brim", [...KIT_PARTS.brim], 2),
      select(2, "extra", [...KIT_PARTS.extra], 1),
      { type: "minecraft:condition", property: "minecraft:custom_model_data", index: 0, on_true: part("band", 1), on_false: { type: "minecraft:empty" } },
    ],
  },
};
writeFileSync(`${root}/assets/sharedcosmetics/items/kit.json`, JSON.stringify(item, null, 2) + "\n");
