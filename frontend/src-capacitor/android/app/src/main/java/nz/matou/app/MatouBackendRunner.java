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
 * At-rest identity encryption (#117 / #389 / #443): every boot — whichever
 * entry point triggers it — hands {@code Mobile.startWithEncryptionKey} a
 * per-install 32-byte key, generated once and held in an Android
 * Keystore-backed EncryptedSharedPreferences file of its own
 * ({@code matou_backend_secure}, opened only here — NOT the
 * {@code matou_secure} file {@link SecureStoragePlugin} exposes to the WebView,
 * so JS can neither read the key nor delete it), so
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

    // The EncryptedSharedPreferences file holding the identity encryption key.
    // Dedicated to the backend (#443): the WebView's SecureStorage plugin never
    // opens it, so `SecureStorage.getItem/removeItem('backend_identity_key')`
    // cannot reach the crown-jewel key. Same Keystore master key as
    // SecureStoragePlugin, so it shares the trust root — only the namespace is
    // isolated.
    private static final String BACKEND_PREFS_FILE = "matou_backend_secure";
    // The JS-reachable SecureStorage file (SecureStoragePlugin.PREFS_FILE) where
    // installs from before #443 stored the key. Read once, for migration, then
    // vacated.
    private static final String LEGACY_PREFS_FILE = "matou_secure";
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
     * backend's own Keystore-backed prefs, migrating it out of the JS-reachable
     * SecureStorage file for installs that predate #443. On any secure-storage
     * failure it logs a single warning (never the key) and returns "" so the
     * backend takes the legacy plaintext path rather than refusing to boot —
     * and never mints a fresh key on a fault, which would orphan an
     * already-encrypted identity.json.
     */
    private static String identityEncryptionKey(Context context) {
        try {
            return loadOrCreateIdentityKey(
                new PrefsBacking(context, BACKEND_PREFS_FILE),
                new PrefsBacking(context, LEGACY_PREFS_FILE));
        } catch (Exception e) {
            Log.w(TAG, "secure storage unavailable; identity will use the legacy plaintext path: " + e.getMessage());
            return "";
        }
    }

    /** Opens a Keystore-backed EncryptedSharedPreferences file (same master key as SecureStoragePlugin). */
    private static SharedPreferences openSecurePrefs(Context context, String file) throws Exception {
        MasterKey masterKey = new MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                context,
                file,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /**
     * A minimal string-keyed persistence seam. Its only production implementation
     * is {@link PrefsBacking} over EncryptedSharedPreferences, but factoring it
     * out lets the generate-once / read-back / migrate logic be unit-tested on
     * the JVM without the Android Keystore (MatouBackendRunnerTest). Every method
     * throws an unchecked exception on a secure-storage fault.
     */
    interface KeyBacking {
        /** The stored value for name, or null when absent. */
        String get(String name);

        /** Persist value under name; throws if it cannot be persisted. */
        void put(String name, String value);

        /** Delete name; a missing entry is success. */
        void remove(String name);
    }

    /**
     * KeyBacking over one EncryptedSharedPreferences file, opened lazily on first
     * use so the legacy file is only touched on the boot that migrates it.
     */
    private static final class PrefsBacking implements KeyBacking {
        private final Context context;
        private final String file;
        private SharedPreferences prefs;

        PrefsBacking(Context context, String file) {
            this.context = context;
            this.file = file;
        }

        private SharedPreferences prefs() {
            if (prefs == null) {
                try {
                    prefs = openSecurePrefs(context, file);
                } catch (Exception e) {
                    Log.w(TAG, "identity key: cannot open secure prefs " + file + ": " + e.getMessage());
                    throw new IllegalStateException("opening " + file + ": " + e.getMessage(), e);
                }
            }
            return prefs;
        }

        @Override
        public String get(String name) {
            return prefs().getString(name, null);
        }

        @Override
        public void put(String name, String value) {
            if (!prefs().edit().putString(name, value).commit()) {
                // Refuse to encrypt with a key we could not persist — a key
                // lost across boots would make identity.json unreadable.
                Log.w(TAG, "identity key: failed to persist " + name + " in " + file);
                throw new IllegalStateException("failed to persist identity encryption key in " + file);
            }
        }

        @Override
        public void remove(String name) {
            if (!prefs().edit().remove(name).commit()) {
                Log.w(TAG, "identity key: failed to remove " + name + " from " + file + " (legacy copy retained)");
                throw new IllegalStateException("failed to remove " + name + " from " + file);
            }
            Log.i(TAG, "identity key: removed " + name + " from " + file + " (migrated to isolated backend store, #443)");
        }
    }

    /**
     * Returns the persisted per-install identity encryption key from the
     * backend's isolated store, generating and storing 32 random bytes
     * (hex-encoded) on first call so subsequent boots read back the identical
     * key. StartWithEncryptionKey / deriveKey hashes the material, so the hex
     * encoding is only a stable, storage-safe representation (minSdk 23 rules
     * out java.util.Base64; hex mirrors the token encoding).
     *
     * Migration (#443): when the isolated store is empty, the JS-reachable
     * legacy store is consulted BEFORE minting — an install from before #443
     * has an identity.json encrypted under the key that lives there. A found
     * legacy key is copied into the isolated store and the legacy copy deleted;
     * the returned value is the legacy key regardless, so identity.json still
     * decrypts this boot even if the write half-fails (retried next boot, since
     * the legacy copy is then kept). A fault reading either store propagates:
     * it is inconclusive, and minting a fresh key would orphan identity.json.
     * A put failure on a genuinely fresh key also propagates: a key that was
     * not persisted must never be used.
     */
    static String loadOrCreateIdentityKey(KeyBacking backend, KeyBacking legacy) {
        String existing = backend.get(IDENTITY_KEY_NAME);
        if (existing != null && !existing.isEmpty()) {
            return existing;
        }

        String legacyKey = legacy.get(IDENTITY_KEY_NAME);
        if (legacyKey != null && !legacyKey.isEmpty()) {
            // No android.util.Log here: this seam runs on a plain JVM in
            // MatouBackendRunnerTest; PrefsBacking logs at its fault sites.
            try {
                backend.put(IDENTITY_KEY_NAME, legacyKey);
            } catch (RuntimeException e) {
                // Migration write failed: retain the legacy copy, retry next boot.
                return legacyKey;
            }
            try {
                legacy.remove(IDENTITY_KEY_NAME);
            } catch (RuntimeException e) {
                // Both copies exist; the isolated one wins on every later boot.
            }
            return legacyKey;
        }

        String fresh = randomHex(32);
        backend.put(IDENTITY_KEY_NAME, fresh);
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
