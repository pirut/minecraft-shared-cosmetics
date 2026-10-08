package dev.sharedcosmetics;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.function.BiConsumer;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * Listens to the API's server-sent event stream so changes made on another server (or by an admin)
 * show up here immediately. Reconnects with backoff; after every (re)connect {@code onConnected}
 * runs so anything missed while disconnected is re-fetched. Callbacks run on the sync thread.
 */
public final class LiveSync {

    /** No byte for this long (the API pings every 25s) means the connection is dead. */
    private static final long IDLE_TIMEOUT_MS = 75_000;
    private static final long MAX_BACKOFF_MS = 60_000;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final URI uri;
    private final String serverKey;
    private final Logger logger;
    private final Runnable onConnected;
    private final BiConsumer<String, JsonObject> onEvent;

    private volatile boolean running;
    private volatile Stream<String> current;
    private volatile long lastActivity;
    private Thread thread;
    private Thread watchdog;

    public LiveSync(String baseUrl, String serverKey, Logger logger, Runnable onConnected, BiConsumer<String, JsonObject> onEvent) {
        this.uri = URI.create(baseUrl.replaceAll("/+$", "") + "/v1/events");
        this.serverKey = serverKey;
        this.logger = logger;
        this.onConnected = onConnected;
        this.onEvent = onEvent;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = Thread.ofPlatform().daemon().name("SharedCosmetics-LiveSync").start(this::run);
        watchdog = Thread.ofPlatform().daemon().name("SharedCosmetics-LiveSync-Watchdog").start(this::watch);
    }

    public synchronized void stop() {
        running = false;
        closeCurrent();
        if (thread != null) thread.interrupt();
        if (watchdog != null) watchdog.interrupt();
    }

    private void run() {
        long backoff = 1_000;
        boolean warned = false;
        while (running) {
            try {
                HttpRequest request = HttpRequest.newBuilder(uri)
                        .header("Authorization", "Bearer " + serverKey)
                        .header("Accept", "text/event-stream")
                        .GET()
                        .build();
                HttpResponse<Stream<String>> response = http.send(request, HttpResponse.BodyHandlers.ofLines());
                if (response.statusCode() != 200) {
                    response.body().close();
                    throw new IOException("event stream answered HTTP " + response.statusCode());
                }
                current = response.body();
                lastActivity = System.currentTimeMillis();
                if (warned) logger.info("Live sync reconnected.");
                warned = false;
                backoff = 1_000;
                onConnected.run();
                consume(response.body());
            } catch (Exception e) {
                if (!running) return;
                // The watchdog interrupts a stuck read; clear that so the backoff sleep still happens.
                Thread.interrupted();
                // Log the first failure only, so an API outage doesn't flood the console.
                if (!warned) logger.warning("Live sync disconnected (" + e.getMessage() + "); retrying in the background.");
                warned = true;
            } finally {
                closeCurrent();
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                if (!running) return;
            }
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }

    /** Parses the event stream: "event:" and "data:" lines, a blank line ends each event. */
    private void consume(Stream<String> lines) {
        String[] event = {null};
        StringBuilder data = new StringBuilder();
        lines.forEach(line -> {
            lastActivity = System.currentTimeMillis();
            if (line.isEmpty()) {
                if (event[0] != null && !data.isEmpty()) dispatch(event[0], data.toString());
                event[0] = null;
                data.setLength(0);
            } else if (line.startsWith("event:")) {
                event[0] = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
                if (!data.isEmpty()) data.append('\n');
                data.append(line.substring(5).trim());
            }
            // Lines starting with ':' are keep-alive comments.
        });
        if (running) throw new IllegalStateException("event stream closed by the API");
    }

    private void dispatch(String event, String data) {
        try {
            onEvent.accept(event, JsonParser.parseString(data).getAsJsonObject());
        } catch (RuntimeException e) {
            logger.log(Level.WARNING, "Ignoring bad live sync event " + event + ": " + data, e);
        }
    }

    private void watch() {
        while (running) {
            try {
                Thread.sleep(15_000);
            } catch (InterruptedException e) {
                return;
            }
            if (current != null && System.currentTimeMillis() - lastActivity > IDLE_TIMEOUT_MS) {
                // Closing the stream and waking the reader makes it fall through and reconnect.
                closeCurrent();
                thread.interrupt();
            }
        }
    }

    private void closeCurrent() {
        Stream<String> stream = current;
        current = null;
        if (stream != null) stream.close();
    }
}
