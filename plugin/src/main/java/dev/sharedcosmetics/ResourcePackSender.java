package dev.sharedcosmetics;

import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.UUID;
import net.kyori.adventure.resource.ResourcePackInfo;
import net.kyori.adventure.resource.ResourcePackRequest;
import net.kyori.adventure.text.Component;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerResourcePackStatusEvent;
import org.bukkit.plugin.Plugin;

/**
 * Sends the shared resource pack to players. Clients since 1.20.3 hold several server packs at
 * once, keyed by id, so this pack is added next to whatever pack the server already sends
 * instead of replacing it. Its assets all live under the {@code sharedcosmetics} namespace, so
 * the two never overwrite each other's files. Main thread only.
 */
public final class ResourcePackSender implements Listener {

    /** Fixed, so re-sending a new version replaces our previous one rather than stacking a copy. */
    static final UUID PACK_ID = UUID.nameUUIDFromBytes("sharedcosmetics:resourcepack".getBytes(StandardCharsets.UTF_8));

    private final Plugin plugin;
    private final boolean required;
    private final Component prompt;
    private ApiClient.PackInfo pack;

    public ResourcePackSender(Plugin plugin, boolean required, Component prompt) {
        this.plugin = plugin;
        this.required = required;
        this.prompt = prompt;
    }

    /** Takes the latest pack from the API; players already online get it right away if it changed. */
    public void update(ApiClient.PackInfo fresh) {
        if (Objects.equals(pack, fresh)) return;
        pack = fresh;
        for (Player player : plugin.getServer().getOnlinePlayers()) {
            if (fresh == null) player.removeResourcePacks(PACK_ID);
            else send(player);
        }
    }

    public void send(Player player) {
        if (pack == null) return;
        player.sendResourcePacks(ResourcePackRequest.resourcePackRequest()
                .packs(ResourcePackInfo.resourcePackInfo(PACK_ID, pack.url(), pack.sha1()))
                .replace(false)
                .required(required)
                .prompt(prompt)
                .build());
    }

    @EventHandler
    public void onStatus(PlayerResourcePackStatusEvent event) {
        if (!PACK_ID.equals(event.getID())) return;
        switch (event.getStatus()) {
            // Usually a hosting problem (unreachable url, or bytes that don't match the sha1), so tell the admin.
            case FAILED_DOWNLOAD, INVALID_URL, FAILED_RELOAD -> plugin.getLogger().warning(
                    event.getPlayer().getName() + " could not load the shared resource pack (" + event.getStatus()
                            + ") from " + (pack == null ? "?" : pack.url()));
            default -> {}
        }
    }
}
