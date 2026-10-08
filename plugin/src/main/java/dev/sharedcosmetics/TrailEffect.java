package dev.sharedcosmetics;

import org.bukkit.Bukkit;
import org.bukkit.Color;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.block.data.BlockData;
import org.bukkit.inventory.ItemStack;

/**
 * A trail cosmetic's particle, with any extra data it needs, parsed once from the catalog.
 * Keys in the cosmetic's {@code data}:
 * <ul>
 *   <li>{@code particle}: Bukkit particle name, e.g. {@code HEART}, {@code DUST}</li>
 *   <li>{@code count}: particles per emit (default 1)</li>
 *   <li>{@code color}, {@code toColor}: {@code "#rrggbb"}, for DUST, DUST_COLOR_TRANSITION and ENTITY_EFFECT</li>
 *   <li>{@code size}: dust size, 0.01 to 4 (default 1)</li>
 *   <li>{@code block}: block data string, e.g. {@code "minecraft:cherry_leaves"}, for BLOCK, FALLING_DUST, DUST_PILLAR</li>
 *   <li>{@code item}: material name for ITEM</li>
 *   <li>{@code value}: number for SCULK_CHARGE (roll, radians) and SHRIEK (delay, ticks)</li>
 * </ul>
 */
public record TrailEffect(Particle particle, Object data, int count) {

    /** Parses a trail cosmetic, throwing IllegalArgumentException with a readable reason if it's invalid. */
    static TrailEffect parse(Cosmetic cosmetic) {
        String name = cosmetic.dataString("particle", "HEART");
        Particle particle;
        try {
            particle = Particle.valueOf(name.toUpperCase());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("unknown particle " + name);
        }
        int count = Math.clamp(cosmetic.dataInt("count", 1), 1, 20);
        return new TrailEffect(particle, dataFor(particle, cosmetic), count);
    }

    private static Object dataFor(Particle particle, Cosmetic cosmetic) {
        Class<?> type = particle.getDataType();
        if (type == Void.class) return null;
        if (type == Particle.DustOptions.class) {
            return new Particle.DustOptions(color(cosmetic, "color", Color.RED), size(cosmetic));
        }
        if (type == Particle.DustTransition.class) {
            return new Particle.DustTransition(
                    color(cosmetic, "color", Color.RED), color(cosmetic, "toColor", Color.WHITE), size(cosmetic));
        }
        if (type == Color.class) return color(cosmetic, "color", Color.WHITE);
        if (type == BlockData.class) {
            // Throws IllegalArgumentException for unknown blocks or bad block states.
            return Bukkit.createBlockData(cosmetic.dataString("block", "minecraft:stone"));
        }
        if (type == ItemStack.class) {
            String name = cosmetic.dataString("item", "DIAMOND");
            Material material = Material.matchMaterial(name);
            if (material == null || !material.isItem()) throw new IllegalArgumentException("unknown item " + name);
            return new ItemStack(material);
        }
        if (type == Float.class) return cosmetic.data().has("value") ? cosmetic.data().get("value").getAsFloat() : 0f;
        if (type == Integer.class) return cosmetic.dataInt("value", 0);
        // Vibration and similar need a target location, which makes no sense for a trail.
        throw new IllegalArgumentException("particle " + particle + " can't be used as a trail");
    }

    private static Color color(Cosmetic cosmetic, String key, Color fallback) {
        String raw = cosmetic.dataString(key, null);
        if (raw == null) return fallback;
        String hex = raw.startsWith("#") ? raw.substring(1) : raw;
        if (!hex.matches("[0-9a-fA-F]{6}")) throw new IllegalArgumentException(key + " must look like #ff8800, got " + raw);
        return Color.fromRGB(Integer.parseInt(hex, 16));
    }

    private static float size(Cosmetic cosmetic) {
        float size = cosmetic.data().has("size") ? cosmetic.data().get("size").getAsFloat() : 1f;
        return Math.clamp(size, 0.01f, 4f);
    }

    void spawn(Location at) {
        at.getWorld().spawnParticle(particle, at, count, 0.2, 0.05, 0.2, 0, data);
    }
}
