package nz.matou.app;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;

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
 */
@CapacitorPlugin(name = "MatouBackend")
public class MatouBackendPlugin extends Plugin {

    private static final String TAG = "MatouBackend";

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
                        String freshToken = randomToken();
                        File dataDir = new File(getContext().getFilesDir(), "matou");
                        port = Mobile.start(dataDir.getAbsolutePath(), configServerUrl, freshToken);
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
     * Whether push notifications can actually be registered on this build.
     *
     * The push slice (@capacitor/push-notifications) is compiled into every
     * Android build unconditionally, but the Firebase Gradle plugin — and with it
     * the generated resources that let FirebaseInitProvider auto-initialise the
     * default FirebaseApp — is applied only when google-services.json is present
     * at build time (app/build.gradle). A config-less build (the Play beta that
     * shipped with the secret missing, and every coa tenant build by design) thus
     * carries the push plugin but no default FirebaseApp, so
     * PushNotifications.register() throws an uncaught IllegalStateException on the
     * native plugins thread and kills the process (#384). The frontend consults
     * this before ever calling register().
     *
     * FirebaseApp.getApps() returns the initialised apps (empty when none) and
     * does not throw when Firebase was never configured, so the check is safe.
     */
    @PluginMethod
    public void isPushAvailable(PluginCall call) {
        boolean available = !FirebaseApp.getApps(getContext()).isEmpty();
        JSObject ret = new JSObject();
        ret.put("available", available);
        call.resolve(ret);
    }

    /** 32 random bytes, hex-encoded — mirrors the Electron launcher's per-launch API token. */
    private static String randomToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        StringBuilder hex = new StringBuilder(raw.length * 2);
        for (byte b : raw) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
