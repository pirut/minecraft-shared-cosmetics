package dev.sharedcosmetics;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Particle;
import org.bukkit.entity.ItemDisplay;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.Plugin;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.util.Transformation;
import org.joml.AxisAngle4f;
import org.joml.Vector3f;

/**
 * Draws equipped cosmetics using only vanilla client features, so players need no mod:
 * hats are ItemDisplay entities riding the player, trails are particles.
 * Main thread only.
 */
public final class CosmeticRenderer {

    private static final class State {
        Map<String, String> equipped = Map.of();
        ItemDisplay hat;
        Location lastTrailAt;
    }

    private final Plugin plugin;
    private final Function<String, Cosmetic> catalog;
    private final float hatOffsetY;
    private final Map<UUID, State> states = new HashMap<>();

    public CosmeticRenderer(Plugin plugin, Function<String, Cosmetic> catalog, float hatOffsetY) {
        this.plugin = plugin;
        this.catalog = catalog;
        this.hatOffsetY = hatOffsetY;
    }

    public void apply(Player player, Map<String, String> equipped) {
        State state = states.computeIfAbsent(player.getUniqueId(), id -> new State());
        state.equipped = Map.copyOf(equipped);
        removeHat(state);
        refreshHat(player, state);
    }

    public void clear(Player player) {
        State state = states.remove(player.getUniqueId());
        if (state != null) removeHat(state);
    }

    public void clearAll() {
        states.values().forEach(this::removeHat);
        states.clear();
    }

    /** Re-draws everything, e.g. after the catalog changed. */
    public void reapplyAll() {
        for (Player player : plugin.getServer().getOnlinePlayers()) {
            State state = states.get(player.getUniqueId());
            if (state != null) apply(player, state.equipped);
        }
    }

    /** Runs every few ticks: keeps hats mounted and facing forward, emits trails. */
    public void tick() {
        for (Player player : plugin.getServer().getOnlinePlayers()) {
            State state = states.get(player.getUniqueId());
            if (state == null) continue;
            refreshHat(player, state);
            emitTrail(player, state);
        }
    }

    private static boolean visible(Player player) {
        return !player.isDead()
                && player.getGameMode() != GameMode.SPECTATOR
                && !player.hasPotionEffect(PotionEffectType.INVISIBILITY);
    }

    private void refreshHat(Player player, State state) {
        Cosmetic cosmetic = equippedCosmetic(state, "head");
        if (cosmetic == null || !visible(player)) {
            removeHat(state);
            return;
        }
        // Teleports, world changes and death all dismount passengers; respawn the hat when that happens.
        if (state.hat != null && (!state.hat.isValid() || !player.getPassengers().contains(state.hat))) {
            removeHat(state);
        }
        if (state.hat == null) {
            state.hat = spawnHat(player, cosmetic);
        }
        state.hat.setRotation(player.getLocation().getYaw(), 0);
    }

    private ItemDisplay spawnHat(Player player, Cosmetic cosmetic) {
        Material material = Material.matchMaterial(cosmetic.dataString("material", "CARVED_PUMPKIN"));
        ItemStack item = new ItemStack(material != null && material.isItem() ? material : Material.CARVED_PUMPKIN);
        String itemModel = cosmetic.dataString("itemModel", null);
        if (itemModel != null) {
            // Points at a model in the shared resource pack; falls back to the material without it.
            NamespacedKey key = NamespacedKey.fromString(itemModel);
            if (key != null) item.editMeta(meta -> meta.setItemModel(key));
        }
        ItemDisplay display = player.getWorld().spawn(player.getLocation(), ItemDisplay.class, d -> {
            d.setPersistent(false);
            d.setItemStack(item);
            d.setItemDisplayTransform(ItemDisplay.ItemDisplayTransform.HEAD);
            d.setTransformation(new Transformation(
                    new Vector3f(0, hatOffsetY, 0), new AxisAngle4f(), new Vector3f(1, 1, 1), new AxisAngle4f()));
        });
        player.addPassenger(display);
        // The wearer would otherwise see the hat floating in front of their camera.
        player.hideEntity(plugin, display);
        return display;
    }

    private void removeHat(State state) {
        if (state.hat != null) {
            state.hat.remove();
            state.hat = null;
        }
    }

    private void emitTrail(Player player, State state) {
        Cosmetic cosmetic = equippedCosmetic(state, "trail");
        if (cosmetic == null || !visible(player)) return;
        Location now = player.getLocation();
        Location last = state.lastTrailAt;
        state.lastTrailAt = now;
        // Only while moving, so idle players don't sit in a particle cloud.
        if (last == null || last.getWorld() != now.getWorld() || last.distanceSquared(now) < 0.01) return;

        Particle particle;
        try {
            particle = Particle.valueOf(cosmetic.dataString("particle", "HEART"));
        } catch (IllegalArgumentException e) {
            return;
        }
        // Particles that need extra data (dust colors, block states) aren't supported yet.
        if (particle.getDataType() != Void.class) return;
        now.getWorld().spawnParticle(particle, now.add(0, 0.1, 0), cosmetic.dataInt("count", 1), 0.2, 0.05, 0.2, 0);
    }

    private Cosmetic equippedCosmetic(State state, String slot) {
        String id = state.equipped.get(slot);
        return id == null ? null : catalog.apply(id);
    }
}
