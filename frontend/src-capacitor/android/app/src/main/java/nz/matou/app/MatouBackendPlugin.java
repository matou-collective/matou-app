package nz.matou.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nz.matou.backend.mobile.Mobile;

/**
 * Boots the embedded Go backend (gomobile .aar, see backend/cmd/mobile) and
 * hands the WebView what it needs to talk to it. getInfo() returns
 * {port, token} — the same contract the Electron preload exposes via the
 * get-backend-port / get-api-token IPC handlers, so the frontend's API client
 * works unchanged on Android.
 *
 * The backend listens on 127.0.0.1 only; the per-launch 32-byte token is what
 * TokenGuard requires on mutating requests. configServerUrl comes from the
 * plugin config in capacitor.config.json, baked from VITE_PROD_CONFIG_URL by
 * scripts/android/build-apk.sh.
 *
 * At-rest identity encryption (#117): a per-install 32-byte key, generated once
 * and held in the Android Keystore-backed EncryptedSharedPreferences (the same
 * matou_secure trust root SecureStoragePlugin uses), is handed to
 * Mobile.startWithEncryptionKey so {dataDir}/matou/identity.json is written as
 * AES-256-GCM ciphertext rather than a plaintext mnemonic. If secure storage is
 * unavailable we fall back to the empty-key legacy plaintext path so the app
 * still boots.
 */
@CapacitorPlugin(name = "MatouBackend")
public class MatouBackendPlugin extends Plugin {

    private static final String TAG = "MatouBackend";

    // The EncryptedSharedPreferences file and key name for the identity
    // encryption key. SECURE_PREFS_FILE must match SecureStoragePlugin.PREFS_FILE
    // so both share one Keystore-backed trust root (matou_secure.xml).
    private static final String SECURE_PREFS_FILE = "matou_secure";
    static final String IDENTITY_KEY_NAME = "backend_identity_key";

    // Mobile.start blocks while the backend boots (it fetches config over the
    // network), so it must run off the main thread. One executor also serializes
    // concurrent getInfo() calls from the WebView.
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Start once per process; Mobile.start is idempotent on the Go side, but the
    // token must stay stable across getInfo() calls so every caller can auth.
    private long port = 0;
    private String token = null;

    @PluginMethod
    public void getInfo(PluginCall call) {
        String configServerUrl = getConfig().getString("configServerUrl", "");
        if (configServerUrl == null || configServerUrl.isEmpty()) {
            call.reject("MatouBackend: configServerUrl missing from capacitor.config.json plugins config — run scripts/android/build-apk.sh");
            return;
        }

        executor.execute(() -> {
            try {
                synchronized (this) {
                    if (token == null) {
                        String freshToken = randomHex(32);
                        File dataDir = new File(getContext().getFilesDir(), "matou");
                        String encryptionKey = identityEncryptionKey();
                        port = Mobile.startWithEncryptionKey(dataDir.getAbsolutePath(), configServerUrl, freshToken, encryptionKey);
                        token = freshToken;
                        Log.i(TAG, "backend up on 127.0.0.1:" + port);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("port", port);
                ret.put("token", token);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "backend start failed", e);
                call.reject("MatouBackend: backend start failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * The per-install identity encryption key handed to StartWithEncryptionKey.
     * Reads (or, on first launch, generates and persists) the key from the
     * Keystore-backed secure prefs. On any secure-storage failure it logs a
     * single warning (never the key) and returns "" so the backend takes the
     * legacy plaintext path rather than refusing to boot.
     */
    private String identityEncryptionKey() {
        try {
            SharedPreferences securePrefs = openSecurePrefs();
            KeyBacking backing = new KeyBacking() {
                @Override
                public String get(String name) {
                    return securePrefs.getString(name, null);
                }

                @Override
                public void put(String name, String value) {
                    if (!securePrefs.edit().putString(name, value).commit()) {
                        // Refuse to encrypt with a key we could not persist — a
                        // key lost across launches would make identity.json
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
    private SharedPreferences openSecurePrefs() throws Exception {
        Context ctx = getContext();
        MasterKey masterKey = new MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                ctx,
                SECURE_PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /**
     * A minimal string-keyed persistence seam. Its only production implementation
     * is over EncryptedSharedPreferences, but factoring it out lets the
     * generate-once / read-back logic be unit-tested on the JVM without the
     * Android Keystore.
     */
    interface KeyBacking {
        /** The stored value for name, or null when absent. */
        String get(String name);

        /** Persist value under name; throws if it cannot be persisted. */
        void put(String name, String value);
    }

    /**
     * Returns the persisted per-install identity encryption key, generating and
     * storing 32 random bytes (hex-encoded) on first call so subsequent launches
     * read back the identical key. StartWithEncryptionKey / deriveKey hashes the
     * material, so the hex encoding is only a stable, storage-safe representation.
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

    /** nBytes of secure randomness, hex-encoded. */
    static String randomHex(int nBytes) {
        byte[] raw = new byte[nBytes];
        new SecureRandom().nextBytes(raw);
        StringBuilder hex = new StringBuilder(raw.length * 2);
        for (byte b : raw) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
