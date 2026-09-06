package nz.matou.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Signal the FCM service that the WebView bridge is (about to be)
        // alive, so push wakes take the JS path, not the headless one (#421).
        MatouAppState.onActivityCreated();
        registerPlugin(MatouBackendPlugin.class);
        registerPlugin(SecureStoragePlugin.class);
        // The @capacitor/push-notifications plugin auto-registers from
        // capacitor.plugins.json; we only need the channels to exist up front
        // (#177 §4) so a notification can be posted the moment one arrives.
        MatouNotificationChannels.ensure(this);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onDestroy() {
        MatouAppState.onActivityDestroyed();
        super.onDestroy();
    }
}
