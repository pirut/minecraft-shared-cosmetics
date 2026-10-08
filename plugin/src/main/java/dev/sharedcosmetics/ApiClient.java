package dev.sharedcosmetics;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** Async HTTP client for the shared cosmetics API. Callbacks run off the main thread. */
public final class ApiClient {

    public record PlayerProfile(List<Cosmetic> owned, Map<String, String> equipped) {}

    public static final class ApiException extends RuntimeException {
        public ApiException(String message) {
            super(message);
        }
    }

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final String baseUrl;
    private final String serverKey;

    public ApiClient(String baseUrl, String serverKey) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.serverKey = serverKey;
    }

    public CompletableFuture<List<Cosmetic>> fetchCatalog() {
        return send(request("/v1/cosmetics").GET()).thenApply(json -> {
            List<Cosmetic> cosmetics = new ArrayList<>();
            for (JsonElement el : json.getAsJsonArray("cosmetics")) {
                cosmetics.add(Cosmetic.fromJson(el.getAsJsonObject()));
            }
            return cosmetics;
        });
    }

    public CompletableFuture<PlayerProfile> fetchPlayer(UUID player) {
        return send(request("/v1/players/" + player).GET()).thenApply(json -> {
            List<Cosmetic> owned = new ArrayList<>();
            for (JsonElement el : json.getAsJsonArray("owned")) {
                owned.add(Cosmetic.fromJson(el.getAsJsonObject()));
            }
            return new PlayerProfile(owned, equippedFrom(json));
        });
    }

    public CompletableFuture<Map<String, String>> equip(UUID player, String slot, String cosmeticId) {
        JsonObject body = new JsonObject();
        body.addProperty("cosmeticId", cosmeticId);
        HttpRequest.Builder req = request("/v1/players/" + player + "/equipped/" + slot)
                .header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(body.toString()));
        return send(req).thenApply(ApiClient::equippedFrom);
    }

    public CompletableFuture<Map<String, String>> unequip(UUID player, String slot) {
        return send(request("/v1/players/" + player + "/equipped/" + slot).DELETE()).thenApply(ApiClient::equippedFrom);
    }

    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + serverKey)
                .header("Accept", "application/json");
    }

    private CompletableFuture<JsonObject> send(HttpRequest.Builder req) {
        return http.sendAsync(req.build(), HttpResponse.BodyHandlers.ofString()).thenApply(res -> {
            JsonObject json = res.body().isBlank() ? new JsonObject() : JsonParser.parseString(res.body()).getAsJsonObject();
            if (res.statusCode() >= 400) {
                String error = json.has("error") ? json.get("error").getAsString() : "HTTP " + res.statusCode();
                throw new ApiException(error);
            }
            return json;
        });
    }

    private static Map<String, String> equippedFrom(JsonObject json) {
        Map<String, String> equipped = new HashMap<>();
        if (json.has("equipped")) {
            json.getAsJsonObject("equipped").entrySet().forEach(e -> equipped.put(e.getKey(), e.getValue().getAsString()));
        }
        return equipped;
    }
}
