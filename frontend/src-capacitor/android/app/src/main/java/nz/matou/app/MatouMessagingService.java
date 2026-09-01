package nz.matou.app;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Matou's FCM entry point (contract docs/architecture/08-push-notifications.md
 * §5). It extends the Capacitor push plugin's {@code MessagingService} so a data
 * message still reaches JS via the {@code pushNotificationReceived} event
 * whenever the WebView bridge is alive — that path is unchanged, and the app
 * manifest drops the plugin's own service so exactly one FirebaseMessagingService
 * handles {@code com.google.firebase.MESSAGING_EVENT}.
 *
 * This subclass exists so the background slice (#177 slice 4) has a single,
 * app-owned hook: when JS is NOT running (app killed / Doze) a high-priority
 * data message ({@code {t:"m", c:<channelId>, k:"dm"|"ch"}}) still starts this
 * service, and slice 4 will wake the embedded backend ({@link MatouBackendPlugin}),
 * sync the one channel named by {@code c}, decrypt locally and post a
 * content-free local notification on the channels created here — no message text
 * ever travels through FCM (§2, §4).
 *
 * Slice 3 keeps the body minimal: ensure the notification channels exist (so a
 * cold-start wake has somewhere to post) and delegate to the plugin for JS
 * delivery.
 */
public class MatouMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        // Guarantee the DM / channel-message channels exist even when the service
        // is started cold, before JS has created them.
        MatouNotificationChannels.ensure(getApplicationContext());
        // TODO(#177 slice 4): when the WebView bridge is not running, perform the
        // sync-only wake described in §5 instead of relying on JS delivery below.
        super.onMessageReceived(remoteMessage);
    }
}
