package nz.matou.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * The two Android notification channels Matou posts chat notifications on
 * (contract docs/architecture/08-push-notifications.md §4): direct messages get
 * their own high-importance channel so they can heads-up and buzz — the §3
 * "instant" tier — while channel/group messages use a quieter default-importance
 * one.
 *
 * They are created natively (from {@link MainActivity} and
 * {@link MatouMessagingService}) so they exist for a cold-start FCM wake, before
 * the frontend has had a chance to run. Creating a channel whose id already
 * exists is a no-op, so this is safe to call repeatedly; the frontend may still
 * refine them later via {@code PushNotifications.createChannel}.
 */
public final class MatouNotificationChannels {

    /** Direct messages — high importance (heads-up), the §3 "instant" tier. */
    public static final String DM = "matou_dm";
    /** Channel / group messages — default importance, quieter (Doze-deferrable). */
    public static final String CHANNEL = "matou_channel";

    private MatouNotificationChannels() {}

    public static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return; // Pre-Android 8 has no notification channels.
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) {
            return;
        }
        NotificationChannel dm = new NotificationChannel(
            DM, "Direct messages", NotificationManager.IMPORTANCE_HIGH);
        dm.setDescription("New direct messages sent to you");

        NotificationChannel channel = new NotificationChannel(
            CHANNEL, "Channel messages", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("New messages in channels you belong to");

        nm.createNotificationChannel(dm);
        nm.createNotificationChannel(channel);
    }
}
