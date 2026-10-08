package dev.sharedcosmetics.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * The animations.json in a bundle: Bedrock animation format with numeric keyframes, linearly
 * interpolated. Molang expressions aren't evaluated; a keyframe that isn't a number counts as 0.
 * Pure data, no Minecraft classes.
 */
final class BedrockAnimation {

    /** One bone's offsets from its rest pose at some moment: degrees, pixels and scale factors. */
    record Pose(float[] rotation, float[] position, float[] scale) {
        static Pose rest() {
            return new Pose(new float[3], new float[3], new float[] {1, 1, 1});
        }
    }

    private record Channels(NavigableMap<Float, float[]> rotation, NavigableMap<Float, float[]> position,
            NavigableMap<Float, float[]> scale) {}

    record Clip(float length, boolean loop, Map<String, Channels> bones) {}

    private final Map<String, Clip> clips;

    private BedrockAnimation(Map<String, Clip> clips) {
        this.clips = clips;
    }

    static BedrockAnimation empty() {
        return new BedrockAnimation(Map.of());
    }

    static BedrockAnimation parse(String json) {
        JsonObject animations = JsonParser.parseString(json).getAsJsonObject().getAsJsonObject("animations");
        Map<String, Clip> clips = new HashMap<>();
        if (animations == null) return new BedrockAnimation(clips);
        for (Map.Entry<String, JsonElement> e : animations.entrySet()) {
            JsonObject a = e.getValue().getAsJsonObject();
            boolean loop = a.has("loop") && a.get("loop").isJsonPrimitive() && a.get("loop").getAsJsonPrimitive().isBoolean()
                    && a.get("loop").getAsBoolean();
            Map<String, Channels> bones = new HashMap<>();
            float length = a.has("animation_length") ? a.get("animation_length").getAsFloat() : 0;
            if (a.has("bones")) {
                for (Map.Entry<String, JsonElement> b : a.getAsJsonObject("bones").entrySet()) {
                    JsonObject ch = b.getValue().getAsJsonObject();
                    Channels channels = new Channels(keyframes(ch.get("rotation")), keyframes(ch.get("position")),
                            keyframes(ch.get("scale")));
                    for (NavigableMap<Float, float[]> k : List.of(channels.rotation, channels.position, channels.scale)) {
                        if (!k.isEmpty()) length = Math.max(length, k.lastKey());
                    }
                    bones.put(b.getKey(), channels);
                }
            }
            clips.put(shortName(e.getKey()), new Clip(length, loop, bones));
        }
        return new BedrockAnimation(clips);
    }

    /** "animation.phoenix_wings.flap" and "flap" both name the clip "flap". */
    static String shortName(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? name : name.substring(dot + 1);
    }

    /** Adds the named clips' offsets at {@code seconds} into {@code poses}, keyed by bone name. */
    void sample(Iterable<String> clipNames, float seconds, Map<String, Pose> poses) {
        for (String name : clipNames) {
            Clip clip = clips.get(shortName(name));
            if (clip == null) continue;
            float t = clip.length > 0 ? (clip.loop ? seconds % clip.length : Math.min(seconds, clip.length)) : 0;
            for (Map.Entry<String, Channels> e : clip.bones.entrySet()) {
                Pose pose = poses.computeIfAbsent(e.getKey(), k -> Pose.rest());
                add(pose.rotation, at(e.getValue().rotation, t, 0));
                add(pose.position, at(e.getValue().position, t, 0));
                float[] s = at(e.getValue().scale, t, 1);
                for (int i = 0; i < 3; i++) pose.scale[i] *= s[i];
            }
        }
    }

    private static void add(float[] into, float[] v) {
        for (int i = 0; i < 3; i++) into[i] += v[i];
    }

    /** Linear interpolation between the keyframes around t, holding the ends. */
    static float[] at(NavigableMap<Float, float[]> keys, float t, float fallback) {
        if (keys.isEmpty()) return new float[] {fallback, fallback, fallback};
        Map.Entry<Float, float[]> lo = keys.floorEntry(t);
        Map.Entry<Float, float[]> hi = keys.ceilingEntry(t);
        if (lo == null) return hi.getValue().clone();
        if (hi == null || hi.getKey().equals(lo.getKey())) return lo.getValue().clone();
        float f = (t - lo.getKey()) / (hi.getKey() - lo.getKey());
        float[] out = new float[3];
        for (int i = 0; i < 3; i++) out[i] = lo.getValue()[i] + (hi.getValue()[i] - lo.getValue()[i]) * f;
        return out;
    }

    /** A channel is a constant vector, a single number (uniform), or a map of time to either. */
    static NavigableMap<Float, float[]> keyframes(JsonElement channel) {
        NavigableMap<Float, float[]> keys = new TreeMap<>();
        if (channel == null) return keys;
        if (channel.isJsonObject() && !channel.getAsJsonObject().has("post")) {
            for (Map.Entry<String, JsonElement> k : channel.getAsJsonObject().entrySet()) {
                try {
                    keys.put(Float.parseFloat(k.getKey()), value(k.getValue()));
                } catch (NumberFormatException ignored) {
                    // Not a timestamp; skip it.
                }
            }
        } else {
            keys.put(0f, value(channel));
        }
        return keys;
    }

    private static float[] value(JsonElement v) {
        if (v.isJsonObject()) {
            JsonObject o = v.getAsJsonObject();
            v = o.has("post") ? o.get("post") : o.get("pre");
            if (v == null) return new float[3];
        }
        if (v.isJsonArray()) {
            float[] out = new float[3];
            for (int i = 0; i < 3 && i < v.getAsJsonArray().size(); i++) out[i] = number(v.getAsJsonArray().get(i));
            return out;
        }
        float n = number(v);
        return new float[] {n, n, n};
    }

    private static float number(JsonElement e) {
        try {
            return e.getAsFloat();
        } catch (RuntimeException notANumber) {
            return 0;
        }
    }
}
