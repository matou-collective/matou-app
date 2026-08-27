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

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Encrypted key/value storage for the WebView — the Android counterpart of
 * Electron's safeStorage-backed secureStorage IPC (issue #71).
 *
 * Values live in EncryptedSharedPreferences ("matou_secure"): keys and values
 * are AES-256 encrypted with a master key held in the Android Keystore, so
 * `shared_prefs/matou_secure.xml` on disk is ciphertext. Nothing secret ever
 * touches WebView localStorage. JS contract (see frontend/src/lib/capacitor.ts):
 *
 *   getItem({key})        -> {value: string | null}
 *   setItem({key, value}) -> void
 *   removeItem({key})     -> void
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {

    private static final String TAG = "SecureStorage";
    private static final String PREFS_FILE = "matou_secure";

    // Keystore + EncryptedSharedPreferences setup does disk and crypto work;
    // keep it (and every call) off the main thread, serialized.
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private synchronized SharedPreferences prefs() throws Exception {
        if (prefs == null) {
            Context ctx = getContext();
            MasterKey masterKey = new MasterKey.Builder(ctx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    ctx,
                    PREFS_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
        return prefs;
    }

    private static String requireKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("SecureStorage: 'key' is required");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void getItem(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        executor.execute(() -> {
            try {
                String value = prefs().getString(key, null);
                JSObject ret = new JSObject();
                // JSObject.put(String, null) would drop the key; be explicit so
                // the JS side always sees a `value` field.
                if (value == null) ret.put("value", JSObject.NULL); else ret.put("value", value);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "getItem failed", e);
                call.reject("SecureStorage: getItem failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void setItem(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null) {
            call.reject("SecureStorage: 'value' is required");
            return;
        }
        executor.execute(() -> {
            try {
                if (!prefs().edit().putString(key, value).commit()) {
                    call.reject("SecureStorage: setItem failed to persist");
                    return;
                }
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "setItem failed", e);
                call.reject("SecureStorage: setItem failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void removeItem(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        executor.execute(() -> {
            try {
                if (!prefs().edit().remove(key).commit()) {
                    call.reject("SecureStorage: removeItem failed to persist");
                    return;
                }
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "removeItem failed", e);
                call.reject("SecureStorage: removeItem failed: " + e.getMessage(), e);
            }
        });
    }
}
