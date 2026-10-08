package dev.sharedcosmetics;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.ItemDisplay;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.Plugin;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.util.Transformation;

/**
 * Draws equipped cosmetics using only vanilla client features, so players need no mod:
 * hats are ItemDisplay entities riding the player, trails are particles.
 * Main thread only.
 */
public final class CosmeticRenderer {

    private static final class State {
        Map<String, String> equipped = Map.of();
        ItemDisplay hat;
        Cosmetic hatCosmetic;
        Transformation hatTransform;
        Location lastTrailAt;
    }

    private final Plugin plugin;
    private final Function<String, Cosmetic> catalog;
    private final HatPlacement placement;
    private final int tickInterval;
    private final Map<UUID, State> states = new HashMap<>();
    /** Parsed trail particles by cosmetic id; empty when the cosmetic's data is invalid. */
    private final Map<String, Optional<TrailEffect>> trails = new HashMap<>();
    private final Set<String> warnedTrails = new HashSet<>();

    public CosmeticRenderer(Plugin plugin, Function<String, Cosmetic> catalog, HatPlacement placement, int tickInterval) {
        this.plugin = plugin;
        this.catalog = catalog;
        this.placement = placement;
        this.tickInterval = tickInterval;
    }

    /** Shows the given equipped cosmetics. A no-op when nothing changed, so repeated syncs don't flicker. */
    public void apply(Player player, Map<String, String> equipped) {
        State state = states.computeIfAbsent(player.getUniqueId(), id -> new State());
        if (state.equipped.equals(equipped)) return;
        state.equipped = Map.copyOf(equipped);
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

    /** Re-draws after the catalog changed: hats whose cosmetic changed are respawned, trails re-parsed. */
    public void catalogChanged() {
        trails.clear();
        warnedTrails.clear();
        for (Player player : plugin.getServer().getOnlinePlayers()) {
            State state = states.get(player.getUniqueId());
            if (state != null) refreshHat(player, state);
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
        Transformation transform = cosmetic == null || !visible(player) ? null : placement.forPose(player);
        if (transform == null) {
            removeHat(state);
            return;
        }
        // Teleports, world changes and death all dismount passengers; respawn the hat when that happens.
        // A different cosmetic (or an updated catalog entry) also needs a fresh item.
        if (state.hat != null
                && (!state.hat.isValid() || !player.getPassengers().contains(state.hat) || !cosmetic.equals(state.hatCosmetic))) {
            removeHat(state);
        }
        if (state.hat == null) {
            state.hat = spawnHat(player, cosmetic, transform);
            state.hatCosmetic = cosmetic;
            state.hatTransform = transform;
        } else if (!transform.equals(state.hatTransform)) {
            // Glide to the new pose instead of snapping, over the time until the next update.
            state.hat.setInterpolationDelay(0);
            state.hat.setInterpolationDuration(tickInterval);
            state.hat.setTransformation(transform);
            state.hatTransform = transform;
        }
        state.hat.setRotation(player.getLocation().getYaw(), 0);
    }

    private ItemDisplay spawnHat(Player player, Cosmetic cosmetic, Transformation transform) {
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
            d.setTransformation(transform);
            // Smooths the yaw updates sent every tick interval.
            d.setTeleportDuration(Math.min(tickInterval, 59));
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
            state.hatCosmetic = null;
            state.hatTransform = null;
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

        trail(cosmetic).ifPresent(effect -> effect.spawn(now.add(0, 0.1, 0)));
    }

    private Optional<TrailEffect> trail(Cosmetic cosmetic) {
        return trails.computeIfAbsent(cosmetic.id(), id -> {
            try {
                return Optional.of(TrailEffect.parse(cosmetic));
            } catch (RuntimeException e) {
                if (warnedTrails.add(id)) plugin.getLogger().warning("Trail " + id + " can't be shown: " + e.getMessage());
                return Optional.empty();
            }
        });
    }

    private Cosmetic equippedCosmetic(State state, String slot) {
        String id = state.equipped.get(slot);
        return id == null ? null : catalog.apply(id);
    }
}
