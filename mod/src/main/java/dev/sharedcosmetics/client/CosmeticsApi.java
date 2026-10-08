package dev.sharedcosmetics.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** The public, keyless part of the shared API. Futures complete off the render thread. */
final class CosmeticsApi {

    /** What the mod draws for a cosmetic: a model bundle on one bone of the player model. */
    record ModelSpec(String bundle, String bone, List<String> animations) {}

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final String baseUrl;

    CosmeticsApi(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    /** Cosmetic id to model, for the cosmetics that have one; the rest are drawn by the server plugin. */
    CompletableFuture<Map<String, ModelSpec>> fetchModels() {
        return send(HttpRequest.newBuilder(URI.create(baseUrl + "/v1/cosmetics")).GET()).thenApply(json -> {
            Map<String, ModelSpec> models = new HashMap<>();
            for (JsonElement el : json.getAsJsonArray("cosmetics")) {
                JsonObject cosmetic = el.getAsJsonObject();
                JsonObject data = cosmetic.getAsJsonObject("data");
                if (data == null || !data.has("model")) continue;
                JsonObject model = data.getAsJsonObject("model");
                List<String> animations = new ArrayList<>();
                if (model.has("animations")) model.getAsJsonArray("animations").forEach(a -> animations.add(a.getAsString()));
                models.put(cosmetic.get("id").getAsString(),
                        new ModelSpec(model.get("bundle").getAsString(), model.get("bone").getAsString(), List.copyOf(animations)));
            }
            return models;
        });
    }

    /** Slot to cosmetic id for each player; players with nothing equipped map to an empty map. */
    CompletableFuture<Map<UUID, Map<String, String>>> fetchEquipped(Collection<UUID> players) {
        JsonArray ids = new JsonArray();
        players.forEach(id -> ids.add(id.toString()));
        JsonObject body = new JsonObject();
        body.add("players", ids);
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/equipped"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()));
        return send(req).thenApply(json -> {
            JsonObject found = json.getAsJsonObject("players");
            Map<UUID, Map<String, String>> result = new HashMap<>();
            for (UUID player : players) {
                Map<String, String> slots = new HashMap<>();
                JsonObject equipped = found.getAsJsonObject(player.toString());
                if (equipped != null) equipped.entrySet().forEach(e -> slots.put(e.getKey(), e.getValue().getAsString()));
                result.put(player, slots);
            }
            return result;
        });
    }

    /** A model bundle's raw bytes; the caller checks them against the hash it asked for. */
    CompletableFuture<byte[]> fetchBundle(String hash) {
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/assets/" + hash))
                .timeout(Duration.ofSeconds(20)).GET().build();
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray()).thenApply(res -> {
            if (res.statusCode() >= 400) throw new IllegalStateException("HTTP " + res.statusCode());
            return res.body();
        });
    }

    private CompletableFuture<JsonObject> send(HttpRequest.Builder req) {
        req.timeout(Duration.ofSeconds(10)).header("Accept", "application/json");
        return http.sendAsync(req.build(), HttpResponse.BodyHandlers.ofString()).thenApply(res -> {
            if (res.statusCode() >= 400) throw new IllegalStateException("HTTP " + res.statusCode());
            return JsonParser.parseString(res.body()).getAsJsonObject();
        });
    }
}
