package nz.matou.app;

import android.util.Log;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Matou's FCM entry point (contract docs/architecture/08-push-notifications.md
 * §5). It extends the Capacitor push plugin's {@code MessagingService} so a data
 * message still reaches JS via the {@code pushNotificationReceived} event
 * whenever the WebView bridge is alive — that path is unchanged, and the app
 * manifest drops the plugin's own service so exactly one FirebaseMessagingService
 * handles {@code com.google.firebase.MESSAGING_EVENT}.
 *
 * When the app UI is dead (process cold-started by FCM, or the activity was
 * finished) the JS path cannot run, so the §5 headless wake takes over (#421):
 * a message signal {@code {t:"m", c:<channelId>, k:"dm"|"ch"}} enqueues
 * {@link PushWakeWorker} — expedited WorkManager work that boots the embedded
 * backend, syncs the one named channel, and posts a content-free local
 * notification composed from local decrypted state. No message text ever
 * travels through FCM (§2, §4) or into logcat.
 *
 * The fork is on {@link MatouAppState#isUiAlive()} (see its doc for why it is
 * reliable). In the headless branch {@code super.onMessageReceived} is
 * deliberately NOT called: with no bridge the plugin would stash the message in
 * its static {@code lastMessage} and re-fire it on the next app launch
 * (PushNotificationsPlugin.load), re-ringing a wake this service already
 * handled — §7 duplicate suppression says one signal, one notification.
 */
public class MatouMessagingService extends MessagingService {

    private static final String TAG = "MatouMessaging";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        // Guarantee the DM / channel-message channels exist even when the service
        // is started cold, before JS has created them.
        MatouNotificationChannels.ensure(getApplicationContext());

        if (MatouAppState.isUiAlive()) {
            // Normal running app: unchanged pre-#421 behaviour — the plugin
            // delivers to JS (immediately, or via its lastMessage stash while
            // the bridge is still booting) and usePush.handlePushReceipt does
            // the sync + notification.
            super.onMessageReceived(remoteMessage);
            return;
        }

        // Cold start / UI dead: §5 headless wake.
        Map<String, String> data = remoteMessage.getData();
        String type = data.get("t");
        String channelId = data.get("c");
        if (!"m".equals(type) || channelId == null || channelId.isEmpty()) {
            // Not a message wake — nothing a headless process can do with it.
            Log.d(TAG, "ignoring non-message push while UI is dead");
            return;
        }
        String kind = "dm".equals(data.get("k")) ? "dm" : "ch";
        PushWakeWorker.enqueue(getApplicationContext(), channelId, kind);
    }
}
