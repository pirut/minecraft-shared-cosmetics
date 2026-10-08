package dev.sharedcosmetics;

import com.google.gson.JsonObject;

/**
 * A catalog entry from the shared API. {@code data} carries render hints:
 * HAT: {"material": "CARVED_PUMPKIN", "itemModel": "sharedcosmetics:top_hat"}
 * TRAIL: {"particle": "HEART", "count": 1}
 */
public record Cosmetic(String id, String name, String type, String slot, JsonObject data) {

    static Cosmetic fromJson(JsonObject json) {
        return new Cosmetic(
                json.get("id").getAsString(),
                json.get("name").getAsString(),
                json.get("type").getAsString(),
                json.get("slot").getAsString(),
                json.has("data") ? json.getAsJsonObject("data") : new JsonObject());
    }

    String dataString(String key, String fallback) {
        return data.has(key) ? data.get(key).getAsString() : fallback;
    }

    int dataInt(String key, int fallback) {
        return data.has(key) ? data.get(key).getAsInt() : fallback;
    }
}
