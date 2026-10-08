package dev.sharedcosmetics;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.File;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabExecutor;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class SharedCosmeticsPlugin extends JavaPlugin implements Listener, TabExecutor {

    private static final long CATALOG_REFRESH_TICKS = 20L * 60 * 5;

    private final Map<String, Cosmetic> catalog = new ConcurrentHashMap<>();
    /** Owned cosmetic ids per online player, for tab completion. */
    private final Map<UUID, Set<String>> owned = new ConcurrentHashMap<>();
    private ApiClient api;
    private CosmeticRenderer renderer;
    /** Null when resource-pack.enabled is false. */
    private ResourcePackSender packSender;
    private LiveSync liveSync;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        String key = getConfig().getString("server-key", "");
        if (key.isBlank()) {
            getLogger().severe("server-key is not set in config.yml; get one from the API with POST /v1/servers.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        String apiUrl = getConfig().getString("api-url", "http://localhost:8080");
        api = new ApiClient(apiUrl, key);
        int tickInterval = Math.max(1, getConfig().getInt("trail-interval-ticks", 2));
        renderer = new CosmeticRenderer(this, catalog::get, HatPlacement.fromConfig(getConfig().getConfigurationSection("hat")), tickInterval);
        warnIfUuidsUntrusted();

        getServer().getPluginManager().registerEvents(this, this);
        if (getConfig().getBoolean("resource-pack.enabled", true)) {
            packSender = new ResourcePackSender(this, getConfig().getBoolean("resource-pack.required", false),
                    MiniMessage.miniMessage().deserialize(getConfig().getString("resource-pack.prompt", "")));
            getServer().getPluginManager().registerEvents(packSender, this);
        }
        PluginCommand command = getCommand("cosmetics");
        if (command != null) command.setExecutor(this);

        getServer().getScheduler().runTaskTimerAsynchronously(this, this::refreshCatalog, 0L, CATALOG_REFRESH_TICKS);
        getServer().getScheduler().runTaskTimer(this, renderer::tick, 1L, tickInterval);

        if (getConfig().getBoolean("live-sync", true)) {
            liveSync = new LiveSync(apiUrl, key, getLogger(), this::resync, this::onLiveEvent);
            liveSync.start();
        }
    }

    @Override
    public void onDisable() {
        if (liveSync != null) liveSync.stop();
        if (renderer != null) renderer.clearAll();
    }

    /**
     * Cosmetics are keyed by Mojang account UUID (version 4). Offline-mode servers and proxies hand out
     * name-based version 3 UUIDs (Floodgate's Bedrock UUIDs are version 0), which anyone could claim,
     * so those players are left out rather than reading or writing someone else's cosmetics.
     */
    static boolean hasMojangUuid(Player player) {
        return player.getUniqueId().version() == 4;
    }

    /** Explains at startup why players would be skipped, and the BungeeCord forwarding caveat. */
    private void warnIfUuidsUntrusted() {
        if (getServer().getOnlineMode()) return;
        boolean bungee = getServer().spigot().getConfig().getBoolean("settings.bungeecord", false);
        YamlConfiguration paper = YamlConfiguration.loadConfiguration(new File("config", "paper-global.yml"));
        boolean velocity = paper.getBoolean("proxies.velocity.enabled", false);
        if (velocity) {
            if (!paper.getBoolean("proxies.velocity.online-mode", true)) {
                getLogger().warning("The Velocity proxy is in offline mode, so players won't get shared cosmetics. Set online-mode = true in velocity.toml.");
            }
        } else if (bungee) {
            getLogger().warning("Behind BungeeCord: make sure the proxy runs online-mode=true and this server only accepts connections"
                    + " from the proxy (firewall), otherwise players can spoof UUIDs. Velocity modern forwarding avoids this.");
        } else {
            getLogger().severe("This server runs in offline mode without proxy forwarding, so player UUIDs can't be trusted."
                    + " Shared cosmetics stay off for every player until online-mode=true or Velocity/BungeeCord forwarding is enabled.");
        }
    }

    private void refreshCatalog() {
        api.fetchCatalog().whenComplete((cosmetics, error) -> {
            if (error != null) {
                getLogger().warning("Could not refresh cosmetics catalog: " + error.getMessage());
                return;
            }
            Map<String, Cosmetic> fresh = cosmetics.stream().collect(Collectors.toMap(Cosmetic::id, c -> c));
            if (fresh.equals(new HashMap<>(catalog))) return;
            catalog.keySet().retainAll(fresh.keySet());
            catalog.putAll(fresh);
            onMain(() -> renderer.catalogChanged());
        });
        if (packSender == null) return;
        api.fetchPack().whenComplete((pack, error) -> {
            if (error != null) {
                getLogger().warning("Could not fetch the shared resource pack: " + error.getMessage());
                return;
            }
            onMain(() -> packSender.update(pack));
        });
    }

    /** After live sync (re)connects: catch up on anything missed while it was down. */
    private void resync() {
        refreshCatalog();
        for (Player player : getServer().getOnlinePlayers()) loadPlayer(player);
    }

    /** A change pushed by the API, made on this server, another server, or by an admin. Runs off the main thread. */
    private void onLiveEvent(String event, JsonObject data) {
        switch (event) {
            case "catalog" -> refreshCatalog();
            case "player" -> {
                UUID uuid = UUID.fromString(data.get("uuid").getAsString());
                Set<String> ownedIds = new HashSet<>();
                for (JsonElement id : data.getAsJsonArray("owned")) ownedIds.add(id.getAsString());
                Map<String, String> equipped = new HashMap<>();
                data.getAsJsonObject("equipped").entrySet().forEach(e -> equipped.put(e.getKey(), e.getValue().getAsString()));
                onMain(() -> {
                    Player player = getServer().getPlayer(uuid);
                    if (player == null || !hasMojangUuid(player)) return;
                    owned.put(uuid, ownedIds);
                    renderer.apply(player, equipped);
                });
            }
            default -> {
                // Newer API versions may add event types; ignore what we don't know.
            }
        }
    }

    private void loadPlayer(Player player) {
        if (!hasMojangUuid(player)) return;
        UUID uuid = player.getUniqueId();
        api.fetchPlayer(uuid, player.getName()).whenComplete((profile, error) -> {
            if (error != null) {
                getLogger().warning("Could not load cosmetics for " + player.getName() + ": " + error.getMessage());
                return;
            }
            owned.put(uuid, profile.owned().stream().map(Cosmetic::id).collect(Collectors.toSet()));
            onMain(() -> {
                if (player.isOnline()) renderer.apply(player, profile.equipped());
            });
        });
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        if (packSender != null) packSender.send(event.getPlayer());
        loadPlayer(event.getPlayer());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        owned.remove(event.getPlayer().getUniqueId());
        renderer.clear(event.getPlayer());
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can use this command.");
            return true;
        }
        if (!hasMojangUuid(player)) {
            player.sendMessage(Component.text("Shared cosmetics need a Mojang account, and this server can't verify yours.", NamedTextColor.RED));
            return true;
        }
        String sub = args.length == 0 ? "list" : args[0].toLowerCase();
        switch (sub) {
            case "list" -> api.fetchPlayer(player.getUniqueId(), player.getName()).whenComplete((profile, error) -> {
                if (error != null) {
                    fail(player, error);
                    return;
                }
                owned.put(player.getUniqueId(), profile.owned().stream().map(Cosmetic::id).collect(Collectors.toSet()));
                if (profile.owned().isEmpty()) {
                    player.sendMessage(Component.text("You don't own any shared cosmetics yet.", NamedTextColor.GRAY));
                    return;
                }
                player.sendMessage(Component.text("Your shared cosmetics:", NamedTextColor.GOLD));
                for (Cosmetic c : profile.owned()) {
                    boolean on = c.id().equals(profile.equipped().get(c.slot()));
                    player.sendMessage(Component.text(" " + (on ? "● " : "○ ") + c.name() + " (" + c.id() + ", " + c.slot() + ")",
                            on ? NamedTextColor.GREEN : NamedTextColor.WHITE));
                }
            });
            case "equip" -> {
                if (args.length < 2) return false;
                Cosmetic cosmetic = catalog.get(args[1]);
                if (cosmetic == null) {
                    player.sendMessage(Component.text("Unknown cosmetic: " + args[1], NamedTextColor.RED));
                    return true;
                }
                updateEquipped(player, api.equip(player.getUniqueId(), cosmetic.slot(), cosmetic.id()), "Equipped " + cosmetic.name() + ".");
            }
            case "link" -> api.createLinkCode(player.getUniqueId(), player.getName()).whenComplete((link, error) -> {
                if (error != null) {
                    fail(player, error);
                    return;
                }
                player.sendMessage(Component.text("Your link code is ", NamedTextColor.GOLD)
                        .append(Component.text(link.code(), NamedTextColor.WHITE))
                        .append(Component.text(". It works once and expires in 10 minutes.", NamedTextColor.GOLD)));
                player.sendMessage(Component.text("Click here to open the cosmetics page", NamedTextColor.AQUA)
                        .decorate(TextDecoration.UNDERLINED)
                        .clickEvent(ClickEvent.openUrl(link.url()))
                        .hoverEvent(HoverEvent.showText(Component.text(link.url()))));
            });
            case "unequip" -> {
                if (args.length < 2) return false;
                updateEquipped(player, api.unequip(player.getUniqueId(), args[1]), "Unequipped your " + args[1] + " cosmetic.");
            }
            default -> {
                return false;
            }
        }
        return true;
    }

    private void updateEquipped(Player player, CompletableFuture<Map<String, String>> request, String success) {
        request.whenComplete((equipped, error) -> {
            if (error != null) {
                fail(player, error);
                return;
            }
            onMain(() -> {
                if (!player.isOnline()) return;
                renderer.apply(player, equipped);
                player.sendMessage(Component.text(success, NamedTextColor.GREEN));
            });
        });
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 1) return filter(List.of("list", "equip", "unequip", "link"), args[0]);
        if (args.length == 2 && args[0].equalsIgnoreCase("equip") && sender instanceof Player player) {
            return filter(List.copyOf(owned.getOrDefault(player.getUniqueId(), Set.of())), args[1]);
        }
        if (args.length == 2 && args[0].equalsIgnoreCase("unequip")) return filter(List.of("head", "trail"), args[1]);
        return List.of();
    }

    private static List<String> filter(List<String> options, String prefix) {
        return options.stream().filter(o -> o.startsWith(prefix.toLowerCase())).sorted().toList();
    }

    private void fail(Player player, Throwable error) {
        Throwable cause = error.getCause() != null ? error.getCause() : error;
        String message = cause instanceof ApiClient.ApiException ? cause.getMessage() : "the cosmetics service is unreachable";
        player.sendMessage(Component.text("Couldn't do that: " + message, NamedTextColor.RED));
    }

    private void onMain(Runnable task) {
        if (isEnabled()) getServer().getScheduler().runTask(this, task);
    }
}
