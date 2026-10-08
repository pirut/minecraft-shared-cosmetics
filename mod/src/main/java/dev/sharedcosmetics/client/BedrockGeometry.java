package dev.sharedcosmetics.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;

/**
 * The geometry.json in a bundle: Blockbench's "Bedrock entity" format (format_version 1.12.0+),
 * box UV only. Coordinates are pixels, y up, with the origin at the pivot of the player bone the
 * cosmetic attaches to. Pure data, no Minecraft classes, so it can be unit tested.
 */
record BedrockGeometry(int textureWidth, int textureHeight, List<Bone> bones) {

    /** Caps that keep a hostile or broken bundle from costing the client anything noticeable. */
    static final int MAX_BONES = 64;
    static final int MAX_CUBES = 512;

    record Bone(String name, String parent, float[] pivot, float[] rotation, List<Cube> cubes) {}

    record Cube(float[] origin, float[] size, int u, int v, float inflate, boolean mirror, float[] pivot, float[] rotation) {}

    static BedrockGeometry parse(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        JsonArray geometries = root.getAsJsonArray("minecraft:geometry");
        if (geometries == null || geometries.isEmpty()) throw new IllegalArgumentException("no minecraft:geometry");
        JsonObject geo = geometries.get(0).getAsJsonObject();
        JsonObject desc = geo.getAsJsonObject("description");
        int tw = desc != null && desc.has("texture_width") ? desc.get("texture_width").getAsInt() : 64;
        int th = desc != null && desc.has("texture_height") ? desc.get("texture_height").getAsInt() : 64;

        List<Bone> bones = new ArrayList<>();
        int cubeCount = 0;
        JsonArray boneArray = geo.has("bones") ? geo.getAsJsonArray("bones") : new JsonArray();
        if (boneArray.size() > MAX_BONES) throw new IllegalArgumentException("more than " + MAX_BONES + " bones");
        for (JsonElement el : boneArray) {
            JsonObject b = el.getAsJsonObject();
            List<Cube> cubes = new ArrayList<>();
            if (b.has("cubes")) {
                for (JsonElement ce : b.getAsJsonArray("cubes")) {
                    JsonObject c = ce.getAsJsonObject();
                    // Per-face UV isn't supported yet; such cubes are skipped rather than drawn wrong.
                    if (!c.has("uv") || !c.get("uv").isJsonArray()) continue;
                    if (++cubeCount > MAX_CUBES) throw new IllegalArgumentException("more than " + MAX_CUBES + " cubes");
                    JsonArray uv = c.getAsJsonArray("uv");
                    cubes.add(new Cube(vec(c, "origin"), vec(c, "size"), (int) uv.get(0).getAsFloat(), (int) uv.get(1).getAsFloat(),
                            c.has("inflate") ? c.get("inflate").getAsFloat() : 0,
                            c.has("mirror") && c.get("mirror").getAsBoolean(),
                            c.has("pivot") ? vec(c, "pivot") : null,
                            c.has("rotation") ? vec(c, "rotation") : null));
                }
            }
            bones.add(new Bone(b.get("name").getAsString(), b.has("parent") ? b.get("parent").getAsString() : null,
                    vec(b, "pivot"), vec(b, "rotation"), List.copyOf(cubes)));
        }
        return new BedrockGeometry(tw, th, List.copyOf(bones));
    }

    /** A 3-vector field, zero when absent. */
    static float[] vec(JsonObject obj, String key) {
        float[] out = new float[3];
        if (obj.has(key) && obj.get(key).isJsonArray()) {
            JsonArray a = obj.getAsJsonArray(key);
            for (int i = 0; i < 3 && i < a.size(); i++) out[i] = a.get(i).getAsFloat();
        }
        return out;
    }
}
