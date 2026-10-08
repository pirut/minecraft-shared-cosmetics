package dev.sharedcosmetics.client;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.AbstractClientPlayerEntity;

/**
 * What nearby players have equipped, refreshed in the background. One batched request covers up
 * to 100 players, and each player is looked up again at most once a minute, so a full server
 * costs a few requests a minute.
 */
final class EquippedCache {

    private static final long PLAYER_TTL_MS = 60_000;
    private static final long CATALOG_TTL_MS = 5 * 60_000;
    private static final int BATCH = 100;

    private record Entry(Map<String, String> slots, long fetchedAt) {}

    private final CosmeticsApi api;
    private final Map<UUID, Entry> players = new ConcurrentHashMap<>();
    private volatile Map<String, CosmeticsApi.ModelSpec> models = Map.of();
    /** Name to UUID for players in the world; render states only carry the name. */
    private volatile Map<String, UUID> byName = Map.of();
    private volatile boolean lookupInFlight;
    /** Backs off after a failed lookup so an unreachable API isn't hit every second. */
    private volatile long retryAt;
    private volatile long catalogFetchedAt;
    private int ticks;

    EquippedCache(CosmeticsApi api) {
        this.api = api;
    }

    void tick(MinecraftClient client) {
        if (client.world == null || ++ticks % 20 != 0) return;
        long now = System.currentTimeMillis();
        if (now - catalogFetchedAt > CATALOG_TTL_MS) {
            catalogFetchedAt = now;
            api.fetchModels().whenComplete((fresh, error) -> {
                if (error != null) SharedCosmeticsClient.LOG.warn("Could not load the cosmetics catalog: {}", error.getMessage());
                else models = Map.copyOf(fresh);
            });
        }

        Map<String, UUID> names = new HashMap<>();
        List<UUID> stale = new ArrayList<>();
        for (AbstractClientPlayerEntity player : client.world.getPlayers()) {
            UUID id = player.getUuid();
            names.put(player.getGameProfile().getName(), id);
            Entry entry = players.get(id);
            if ((entry == null || now - entry.fetchedAt() > PLAYER_TTL_MS) && stale.size() < BATCH) stale.add(id);
        }
        byName = names;
        players.keySet().retainAll(names.values());

        if (stale.isEmpty() || lookupInFlight || now < retryAt) return;
        lookupInFlight = true;
        api.fetchEquipped(stale).whenComplete((found, error) -> {
            lookupInFlight = false;
            if (error != null) {
                SharedCosmeticsClient.LOG.warn("Could not look up equipped cosmetics: {}", error.getMessage());
                retryAt = System.currentTimeMillis() + 30_000;
                return;
            }
            long at = System.currentTimeMillis();
            found.forEach((id, slots) -> players.put(id, new Entry(Map.copyOf(slots), at)));
        });
    }

    /** Models to draw on the named player, by slot. Empty until the first lookup lands. */
    Map<String, CosmeticsApi.ModelSpec> modelsFor(String playerName) {
        UUID id = byName.get(playerName);
        Entry entry = id == null ? null : players.get(id);
        if (entry == null) return Map.of();
        Map<String, CosmeticsApi.ModelSpec> result = new HashMap<>();
        entry.slots().forEach((slot, cosmetic) -> {
            CosmeticsApi.ModelSpec model = models.get(cosmetic);
            if (model != null) result.put(slot, model);
        });
        return result;
    }
}
