package dev.sharedcosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import org.bukkit.Color;
import org.bukkit.NamespacedKey;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.components.CustomModelDataComponent;

/**
 * Builds hats from the parts kit in the shared resource pack. A kit hat is pure data, e.g.
 * {"crown": "tall", "brim": "wide", "band": true, "colors": ["#1c1c21", "#961a22"]}, carried on
 * the item's custom_model_data. The pack's {@code sharedcosmetics:kit} model reads it to pick
 * parts and tint them, so new hats never change the pack and players never re-download it.
 */
final class HatKit {

    static final NamespacedKey MODEL = NamespacedKey.fromString("sharedcosmetics:kit");

    private HatKit() {}

    /**
     * Layout the pack's items/kit.json expects: strings[0] crown, strings[1] brim, strings[2]
     * extra, flags[0] band, colors[0] crown, colors[1] accent (band and extra), colors[2] brim.
     */
    static void apply(ItemStack item, JsonObject kit) {
        Color main = color(kit, 0, Color.fromRGB(0x1C1C21));
        Color accent = color(kit, 1, main);
        Color brim = color(kit, 2, main);
        item.editMeta(meta -> {
            meta.setItemModel(MODEL);
            CustomModelDataComponent data = meta.getCustomModelDataComponent();
            data.setStrings(List.of(part(kit, "crown"), part(kit, "brim"), part(kit, "extra")));
            data.setFlags(List.of(kit.has("band") && kit.get("band").getAsBoolean()));
            data.setColors(new ArrayList<>(List.of(main, accent, brim)));
            meta.setCustomModelDataComponent(data);
        });
    }

    /** Unknown or missing parts become "none", which the pack draws as nothing. */
    private static String part(JsonObject kit, String key) {
        JsonElement value = kit.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : "none";
    }

    private static Color color(JsonObject kit, int index, Color fallback) {
        if (!kit.has("colors") || !kit.get("colors").isJsonArray()) return fallback;
        JsonArray colors = kit.getAsJsonArray("colors");
        if (index >= colors.size()) return fallback;
        String hex = colors.get(index).getAsString().replace("#", "");
        try {
            return Color.fromRGB(Integer.parseInt(hex, 16) & 0xFFFFFF);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
