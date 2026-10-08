package dev.sharedcosmetics;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabExecutor;
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

    @Override
    public void onEnable() {
        saveDefaultConfig();
        String key = getConfig().getString("server-key", "");
        if (key.isBlank()) {
            getLogger().severe("server-key is not set in config.yml; get one from the API with POST /v1/servers.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        api = new ApiClient(getConfig().getString("api-url", "http://localhost:8080"), key);
        renderer = new CosmeticRenderer(this, catalog::get, (float) getConfig().getDouble("hat-offset-y", -0.25));

        getServer().getPluginManager().registerEvents(this, this);
        if (getConfig().getBoolean("resource-pack.enabled", true)) {
            packSender = new ResourcePackSender(this, getConfig().getBoolean("resource-pack.required", false),
                    MiniMessage.miniMessage().deserialize(getConfig().getString("resource-pack.prompt", "")));
            getServer().getPluginManager().registerEvents(packSender, this);
        }
        PluginCommand command = getCommand("cosmetics");
        if (command != null) command.setExecutor(this);

        getServer().getScheduler().runTaskTimerAsynchronously(this, this::refreshCatalog, 0L, CATALOG_REFRESH_TICKS);
        getServer().getScheduler().runTaskTimer(this, renderer::tick, 1L, Math.max(1, getConfig().getLong("trail-interval-ticks", 2)));
    }

    @Override
    public void onDisable() {
        if (renderer != null) renderer.clearAll();
    }

    private void refreshCatalog() {
        api.fetchCatalog().whenComplete((cosmetics, error) -> {
            if (error != null) {
                getLogger().warning("Could not refresh cosmetics catalog: " + error.getMessage());
                return;
            }
            Map<String, Cosmetic> fresh = cosmetics.stream().collect(Collectors.toMap(Cosmetic::id, c -> c));
            catalog.keySet().retainAll(fresh.keySet());
            catalog.putAll(fresh);
            onMain(() -> renderer.reapplyAll());
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

    private void loadPlayer(Player player) {
        UUID uuid = player.getUniqueId();
        api.fetchPlayer(uuid).whenComplete((profile, error) -> {
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
        String sub = args.length == 0 ? "list" : args[0].toLowerCase();
        switch (sub) {
            case "list" -> api.fetchPlayer(player.getUniqueId()).whenComplete((profile, error) -> {
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
        if (args.length == 1) return filter(List.of("list", "equip", "unequip"), args[0]);
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
