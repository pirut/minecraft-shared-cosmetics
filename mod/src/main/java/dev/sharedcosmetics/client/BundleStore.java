package dev.sharedcosmetics.client;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.NativeImageBackedTexture;
import net.minecraft.util.Identifier;

/**
 * Model bundles by hash. A bundle is fetched the first time a player nearby wears it, checked
 * against its hash, kept on disk, and never fetched again: its name is its content.
 */
final class BundleStore {

    private static final Set<String> FILES = Set.of("geometry.json", "texture.png", "animations.json");
    private static final int MAX_BUNDLE_BYTES = 256 * 1024;
    private static final int MAX_ENTRY_BYTES = 1024 * 1024;
    private static final int MAX_TEXTURE_SIZE = 512;
    private static final long RETRY_FAILED_MS = 5 * 60_000;

    private final CosmeticsApi api;
    private final Path cacheDir;
    private final Map<String, BundleModel> ready = new ConcurrentHashMap<>();
    private final Map<String, Long> loadingOrFailedAt = new ConcurrentHashMap<>();

    BundleStore(CosmeticsApi api, Path cacheDir) {
        this.api = api;
        this.cacheDir = cacheDir;
    }

    /** The model if it's loaded; otherwise starts loading it and returns null for now. */
    BundleModel get(String hash) {
        BundleModel model = ready.get(hash);
        if (model != null) return model;
        Long since = loadingOrFailedAt.get(hash);
        long now = System.currentTimeMillis();
        if (since != null && now - since < RETRY_FAILED_MS) return null;
        loadingOrFailedAt.put(hash, now);
        load(hash).whenComplete((parsed, error) -> {
            if (error != null) {
                SharedCosmeticsClient.LOG.warn("Could not load cosmetic bundle {}: {}", hash, error.getMessage());
                return;
            }
            // Textures have to be uploaded on the render thread.
            MinecraftClient.getInstance().execute(() -> {
                Identifier id = Identifier.of("sharedcosmetics", "bundle/" + hash);
                MinecraftClient.getInstance().getTextureManager().registerTexture(id, new NativeImageBackedTexture(parsed.texture));
                ready.put(hash, BundleModel.build(parsed.geometry, parsed.animations, id));
                loadingOrFailedAt.remove(hash);
            });
        });
        return null;
    }

    private record Parsed(BedrockGeometry geometry, BedrockAnimation animations, NativeImage texture) {}

    private CompletableFuture<Parsed> load(String hash) {
        if (!hash.matches("[0-9a-f]{64}")) return CompletableFuture.failedFuture(new IOException("bad bundle id"));
        Path cached = cacheDir.resolve(hash + ".zip");
        CompletableFuture<byte[]> bytes;
        if (Files.exists(cached)) {
            bytes = CompletableFuture.supplyAsync(() -> {
                try {
                    return Files.readAllBytes(cached);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
        } else {
            bytes = api.fetchBundle(hash).thenApply(data -> {
                try {
                    Files.createDirectories(cacheDir);
                    if (verified(hash, data)) Files.write(cached, data);
                } catch (IOException e) {
                    SharedCosmeticsClient.LOG.warn("Could not cache bundle {}: {}", hash, e.getMessage());
                }
                return data;
            });
        }
        return bytes.thenApply(data -> {
            if (!verified(hash, data)) throw new IllegalStateException("contents don't match the bundle's hash");
            try {
                return parse(data);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });
    }

    private static boolean verified(String hash, byte[] data) {
        if (data.length > MAX_BUNDLE_BYTES) return false;
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data)).equals(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Reads only the known files, each capped while inflating, so a zip bomb goes nowhere. */
    static Parsed parse(byte[] zip) throws IOException {
        Map<String, byte[]> files = new HashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                if (!FILES.contains(e.getName())) throw new IOException("unexpected file " + e.getName());
                files.put(e.getName(), readCapped(in));
            }
        }
        byte[] geometry = files.get("geometry.json");
        byte[] texture = files.get("texture.png");
        if (geometry == null || texture == null) throw new IOException("bundle is missing geometry.json or texture.png");
        BedrockGeometry geo = BedrockGeometry.parse(new String(geometry, StandardCharsets.UTF_8));
        BedrockAnimation anim = files.containsKey("animations.json")
                ? BedrockAnimation.parse(new String(files.get("animations.json"), StandardCharsets.UTF_8))
                : BedrockAnimation.empty();
        NativeImage image = NativeImage.read(new ByteArrayInputStream(texture));
        if (image.getWidth() > MAX_TEXTURE_SIZE || image.getHeight() > MAX_TEXTURE_SIZE) {
            image.close();
            throw new IOException("texture is larger than " + MAX_TEXTURE_SIZE + "px");
        }
        return new Parsed(geo, anim, image);
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) {
            if (out.size() + n > MAX_ENTRY_BYTES) throw new IOException("a file in the bundle is too large");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
