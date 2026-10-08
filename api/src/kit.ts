/**
 * The hat parts kit: every option the shared pack's sharedcosmetics:kit model can draw.
 * A kit hat is a combination of these plus colors, so new hats are catalog data and never
 * change the pack. scripts/gen-kit.ts generates the pack's models from the same lists.
 */
export const KIT_PARTS = {
  crown: ["tall", "short", "cone", "dome"],
  brim: ["wide", "narrow"],
  extra: ["ears", "horns", "halo"],
} as const;

const option = (values: readonly string[]) => ({ type: "string", enum: ["none", ...values] });

/** JSON schema for a HAT's data.kit. Colors are crown, accent (band and extra), brim. */
export const KIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    crown: option(KIT_PARTS.crown),
    brim: option(KIT_PARTS.brim),
    extra: option(KIT_PARTS.extra),
    band: { type: "boolean" },
    colors: { type: "array", maxItems: 3, items: { type: "string", pattern: "^#?[0-9a-fA-F]{6}$" } },
  },
};
