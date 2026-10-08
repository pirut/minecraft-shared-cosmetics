package dev.sharedcosmetics.client;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.LivingEntityFeatureRendererRegistrationCallback;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.render.entity.PlayerEntityRenderer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Looks up what every visible player has equipped from the shared API and draws it on their
 * model. Works on any server: it needs only the API, not the server plugin.
 */
public final class SharedCosmeticsClient implements ClientModInitializer {

    public static final Logger LOG = LoggerFactory.getLogger("sharedcosmetics");

    @Override
    public void onInitializeClient() {
        ModConfig config = ModConfig.load(FabricLoader.getInstance().getConfigDir().resolve("sharedcosmetics.properties"));
        CosmeticsApi api = new CosmeticsApi(config.apiUrl());
        EquippedCache cache = new EquippedCache(api);
        BundleStore bundles = new BundleStore(api, FabricLoader.getInstance().getGameDir().resolve("sharedcosmetics").resolve("bundles"));
        ClientTickEvents.END_CLIENT_TICK.register(cache::tick);
        LivingEntityFeatureRendererRegistrationCallback.EVENT.register((entityType, renderer, helper, context) -> {
            if (renderer instanceof PlayerEntityRenderer player) helper.register(new CosmeticFeatureRenderer(player, cache, bundles));
        });
    }
}
