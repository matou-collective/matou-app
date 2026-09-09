package nz.matou.app;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
 * The actual start (and the port/token state) lives in
 * {@link MatouBackendRunner}, shared with the headless push wake (#421): if a
 * wake already booted the backend when the user opens the app, getInfo adopts
 * that instance — same port, same token — instead of racing Mobile.start's
 * idempotency with a token the Go side would ignore.
 */
@CapacitorPlugin(name = "MatouBackend")
public class MatouBackendPlugin extends Plugin {

    private static final String TAG = "MatouBackend";

    // Mobile.start blocks while the backend boots (it fetches config over the
    // network), so it must run off the main thread. One executor also serializes
    // concurrent getInfo() calls from the WebView.
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getInfo(PluginCall call) {
        String configServerUrl = getConfig().getString("configServerUrl", "");
        if (configServerUrl == null || configServerUrl.isEmpty()) {
            call.reject("MatouBackend: configServerUrl missing from capacitor.config.json plugins config — run scripts/android/build-apk.sh");
            return;
        }

        executor.execute(() -> {
            try {
                MatouBackendRunner.Info info = MatouBackendRunner.get()
                    .start(getContext(), configServerUrl, /* fromApp= */ true);
                JSObject ret = new JSObject();
                ret.put("port", info.port);
                ret.put("token", info.token);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "backend start failed", e);
                call.reject("MatouBackend: backend start failed: " + e.getMessage(), e);
            }
        });
    }
}
