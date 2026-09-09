package nz.matou.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import nz.matou.backend.mobile.Mobile;

/**
 * The single per-process owner of the embedded Go backend (#421).
 *
 * Both entry points into {@code Mobile.start} go through here: the WebView path
 * ({@link MatouBackendPlugin#getInfo}) and the headless push wake
 * ({@link PushWakeWorker}). Centralising the call matters because of
 * {@code mobile.Start}'s idempotency contract (backend/cmd/mobile/mobile.go): a
 * second Start while the backend runs returns the EXISTING port and silently
 * ignores the new token. Two independent callers minting their own tokens would
 * therefore leave one of them holding a token TokenGuard rejects. Here exactly
 * one token is minted per backend boot and every caller shares it.
 *
 * Lifecycle (§5 "don't leave it running"):
 * <ul>
 *   <li>{@code start(fromApp=true)} marks the backend as app-owned for the rest
 *       of its life; the headless path never stops an app-owned backend.</li>
 *   <li>The headless path brackets its use with {@link #acquireHeadlessLease}
 *       / {@link #releaseHeadlessLease}. When the last lease is released and
 *       the app never attached (and no activity exists — covering the race
 *       where the user opens the app mid-wake but its {@code getInfo} has not
 *       run yet), the backend is stopped.</li>
 *   <li>If the user opens the app while a headless backend is up, the plugin's
 *       {@code start(fromApp=true)} simply adopts the running instance —
 *       same port, same token — and the wake worker's release becomes a
 *       no-op-stop. No restart, no token mismatch.</li>
 * </ul>
 */
final class MatouBackendRunner {

    private static final String TAG = "MatouBackendRunner";
    private static final MatouBackendRunner INSTANCE = new MatouBackendRunner();

    /** Immutable connection info for one running backend. */
    static final class Info {
        final long port;
        final String token;

        Info(long port, String token) {
            this.port = port;
            this.token = token;
        }
    }

    private boolean started = false;
    private long port = 0;
    private String token = null;
    /** Latched once the app (WebView path) has attached to this backend. */
    private boolean appAttached = false;
    /** Live headless users (one per running wake worker). */
    private int headlessLeases = 0;

    private MatouBackendRunner() {}

    static MatouBackendRunner get() {
        return INSTANCE;
    }

    /**
     * Boot the backend if it is not running in this process, and return the
     * shared {port, token}. Blocking (config is fetched over the network) —
     * never call on the main thread.
     *
     * @param fromApp true when the caller is the WebView plugin: the backend
     *                becomes app-owned and the headless path will not stop it.
     */
    synchronized Info start(Context context, String configServerUrl, boolean fromApp) throws Exception {
        if (!started) {
            String freshToken = randomToken();
            File dataDir = new File(context.getApplicationContext().getFilesDir(), "matou");
            long boundPort = Mobile.start(dataDir.getAbsolutePath(), configServerUrl, freshToken);
            port = boundPort;
            token = freshToken;
            started = true;
            Log.i(TAG, "backend up on 127.0.0.1:" + port + (fromApp ? " (app)" : " (headless)"));
        }
        if (fromApp) {
            appAttached = true;
        }
        return new Info(port, token);
    }

    /** Take a headless lease; pair with {@link #releaseHeadlessLease}. */
    synchronized void acquireHeadlessLease() {
        headlessLeases++;
    }

    /**
     * Release a headless lease and stop the backend when this was the last
     * headless user and the app has no claim on it (§5: never leave a
     * headless-started backend running; never stop one the real app uses).
     */
    synchronized void releaseHeadlessLease() {
        headlessLeases = Math.max(0, headlessLeases - 1);
        if (headlessLeases > 0 || !started) {
            return;
        }
        // MatouAppState covers the window where MainActivity exists but has not
        // called getInfo() yet: leave the backend up for it to adopt.
        if (appAttached || MatouAppState.isUiAlive()) {
            return;
        }
        try {
            Mobile.stop();
            Log.i(TAG, "headless backend stopped");
        } catch (Exception e) {
            Log.e(TAG, "backend stop failed", e);
        }
        started = false;
        port = 0;
        token = null;
        appAttached = false;
    }

    /**
     * The config-server URL baked into the app, read from the packaged
     * Capacitor config (assets/capacitor.config.json,
     * plugins.MatouBackend.configServerUrl) — the same value the WebView path
     * reads through the plugin config, but reachable without a bridge.
     */
    static String configServerUrlFromAssets(Context context) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("capacitor.config.json"), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            JSONObject config = new JSONObject(sb.toString());
            return config.getJSONObject("plugins")
                .getJSONObject("MatouBackend")
                .optString("configServerUrl", "");
        } catch (Exception e) {
            Log.e(TAG, "failed to read configServerUrl from capacitor.config.json", e);
            return "";
        }
    }

    /** 32 random bytes, hex-encoded — the per-launch API token TokenGuard checks. */
    private static String randomToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        StringBuilder hex = new StringBuilder(raw.length * 2);
        for (byte b : raw) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
