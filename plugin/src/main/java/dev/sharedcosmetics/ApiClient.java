package dev.sharedcosmetics;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
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

    public record LinkCode(String code, String url) {}
    /** The shared resource pack: where players download it and the SHA-1 their client checks. */
    public record PackInfo(URI url, String sha1) {}

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

    /** Completes with null when the API has no pack configured. */
    public CompletableFuture<PackInfo> fetchPack() {
        return http.sendAsync(request("/v1/pack").GET().build(), HttpResponse.BodyHandlers.ofString()).thenApply(res -> {
            if (res.statusCode() == 404) return null;
            if (res.statusCode() >= 400) throw new ApiException("HTTP " + res.statusCode());
            JsonObject json = JsonParser.parseString(res.body()).getAsJsonObject();
            // A CDN url if the API has one, otherwise the API itself serves the zip.
            String url = json.has("url") ? json.get("url").getAsString() : baseUrl + json.get("path").getAsString();
            return new PackInfo(URI.create(url), json.get("sha1").getAsString());
        });
    }

    /** Also reports the player's current name so admins can look them up by it. */
    public CompletableFuture<PlayerProfile> fetchPlayer(UUID player, String name) {
        String query = "?name=" + URLEncoder.encode(name, StandardCharsets.UTF_8);
        return send(request("/v1/players/" + player + query).GET()).thenApply(json -> {
            List<Cosmetic> owned = new ArrayList<>();
            for (JsonElement el : json.getAsJsonArray("owned")) {
                owned.add(Cosmetic.fromJson(el.getAsJsonObject()));
            }
            return new PlayerProfile(owned, equippedFrom(json));
        });
    }

    /** A one-time code the player enters on the web page to link it to this account. */
    public CompletableFuture<LinkCode> createLinkCode(UUID player, String name) {
        JsonObject body = new JsonObject();
        body.addProperty("name", name);
        HttpRequest.Builder req = request("/v1/players/" + player + "/link-codes")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()));
        return send(req).thenApply(json -> new LinkCode(json.get("code").getAsString(), json.get("url").getAsString()));
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
