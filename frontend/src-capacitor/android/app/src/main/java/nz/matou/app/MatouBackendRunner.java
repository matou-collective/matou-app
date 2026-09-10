package nz.matou.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

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
 *
 * At-rest identity encryption (#117 / #389): every boot — whichever entry
 * point triggers it — hands {@code Mobile.startWithEncryptionKey} a
 * per-install 32-byte key, generated once and held in the Android
 * Keystore-backed EncryptedSharedPreferences (the same {@code matou_secure}
 * trust root {@link SecureStoragePlugin} uses), so
 * {@code {dataDir}/matou/identity.json} is AES-256-GCM ciphertext rather than
 * a plaintext mnemonic. Passing the key here rather than in the plugin is what
 * makes a headless push wake boot the SAME identity: if only the WebView path
 * supplied it, a wake would start the backend with an empty key (encrypted
 * identity.json unreadable) and the app would then adopt that unconfigured
 * instance for the rest of the process. The key is re-read on every start
 * because the headless path stops and re-starts the backend.
 */
final class MatouBackendRunner {

    private static final String TAG = "MatouBackendRunner";
    private static final MatouBackendRunner INSTANCE = new MatouBackendRunner();

    // The EncryptedSharedPreferences file and key name for the identity
    // encryption key. SECURE_PREFS_FILE must match SecureStoragePlugin.PREFS_FILE
    // so both share one Keystore-backed trust root (matou_secure.xml).
    private static final String SECURE_PREFS_FILE = "matou_secure";
    static final String IDENTITY_KEY_NAME = "backend_identity_key";

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
            String freshToken = randomHex(32);
            Context app = context.getApplicationContext();
            File dataDir = new File(app.getFilesDir(), "matou");
            // Re-read per boot: the headless path stops/re-starts the backend,
            // and a key cached from an earlier boot could be stale after a
            // secure-storage failure recovered in between.
            String encryptionKey = identityEncryptionKey(app);
            long boundPort = Mobile.startWithEncryptionKey(
                dataDir.getAbsolutePath(), configServerUrl, freshToken, encryptionKey);
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

    /**
     * The per-install identity encryption key handed to StartWithEncryptionKey.
     * Reads (or, on first boot, generates and persists) the key from the
     * Keystore-backed secure prefs. On any secure-storage failure it logs a
     * single warning (never the key) and returns "" so the backend takes the
     * legacy plaintext path rather than refusing to boot.
     */
    private static String identityEncryptionKey(Context context) {
        try {
            SharedPreferences securePrefs = openSecurePrefs(context);
            KeyBacking backing = new KeyBacking() {
                @Override
                public String get(String name) {
                    return securePrefs.getString(name, null);
                }

                @Override
                public void put(String name, String value) {
                    if (!securePrefs.edit().putString(name, value).commit()) {
                        // Refuse to encrypt with a key we could not persist — a
                        // key lost across boots would make identity.json
                        // unreadable. The caller falls back to the empty key.
                        throw new IllegalStateException("failed to persist identity encryption key");
                    }
                }
            };
            return loadOrCreateIdentityKey(backing);
        } catch (Exception e) {
            Log.w(TAG, "secure storage unavailable; identity will use the legacy plaintext path: " + e.getMessage());
            return "";
        }
    }

    /** Opens the shared Keystore-backed EncryptedSharedPreferences (matou_secure). */
    private static SharedPreferences openSecurePrefs(Context context) throws Exception {
        MasterKey masterKey = new MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                context,
                SECURE_PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /**
     * A minimal string-keyed persistence seam. Its only production implementation
     * is over EncryptedSharedPreferences, but factoring it out lets the
     * generate-once / read-back logic be unit-tested on the JVM without the
     * Android Keystore (MatouBackendRunnerTest).
     */
    interface KeyBacking {
        /** The stored value for name, or null when absent. */
        String get(String name);

        /** Persist value under name; throws if it cannot be persisted. */
        void put(String name, String value);
    }

    /**
     * Returns the persisted per-install identity encryption key, generating and
     * storing 32 random bytes (hex-encoded) on first call so subsequent boots
     * read back the identical key. StartWithEncryptionKey / deriveKey hashes the
     * material, so the hex encoding is only a stable, storage-safe representation
     * (minSdk 23 rules out java.util.Base64; hex mirrors the token encoding).
     * A put failure propagates: a key that was not persisted must never be used.
     */
    static String loadOrCreateIdentityKey(KeyBacking backing) {
        String existing = backing.get(IDENTITY_KEY_NAME);
        if (existing != null && !existing.isEmpty()) {
            return existing;
        }
        String fresh = randomHex(32);
        backing.put(IDENTITY_KEY_NAME, fresh);
        return fresh;
    }

    /**
     * nBytes of secure randomness, hex-encoded. Used for the per-boot API token
     * TokenGuard checks (32 bytes, as the Electron launcher mints) and for the
     * identity encryption key.
     */
    static String randomHex(int nBytes) {
        byte[] raw = new byte[nBytes];
        new SecureRandom().nextBytes(raw);
        StringBuilder hex = new StringBuilder(raw.length * 2);
        for (byte b : raw) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
