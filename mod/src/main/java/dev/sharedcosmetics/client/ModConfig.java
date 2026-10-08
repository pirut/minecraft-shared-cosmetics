package dev.sharedcosmetics.client;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/** config/sharedcosmetics.properties, written with defaults on first launch. */
public record ModConfig(String apiUrl) {

    private static final String DEFAULT_API_URL = "http://localhost:8080";

    static ModConfig load(Path file) {
        Properties props = new Properties();
        props.setProperty("api-url", DEFAULT_API_URL);
        try {
            if (Files.exists(file)) {
                try (Reader in = Files.newBufferedReader(file)) {
                    props.load(in);
                }
            } else {
                Files.createDirectories(file.getParent());
                try (Writer out = Files.newBufferedWriter(file)) {
                    props.store(out, "Shared Cosmetics: the API every server and client shares");
                }
            }
        } catch (IOException e) {
            SharedCosmeticsClient.LOG.warn("Could not read {}, using defaults", file, e);
        }
        return new ModConfig(props.getProperty("api-url").replaceAll("/+$", ""));
    }
}
