package nz.matou.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.capacitorjs.plugins.localnotifications.LocalNotificationManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Headless push wake (#421, docs/architecture/08-push-notifications.md §5): runs
 * when a content-free FCM signal {@code {t:"m", c:<channelId>, k:"dm"|"ch"}}
 * arrives while the app UI is dead. Boots the embedded backend, waits (bounded)
 * for the named channel to sync over any-sync HeadSync, composes
 * {@code "New message in {channelName}"} from LOCAL decrypted state only, posts
 * it, lingers briefly so message bodies land too, then stops the backend it
 * started (§5 lifecycle — see {@link MatouBackendRunner}).
 *
 * Why WorkManager expedited work: FCM only guarantees the
 * {@code onMessageReceived} thread a handful of seconds, while a cold backend
 * boot (config fetch + any-sync connect) plus a HeadSync cycle routinely
 * exceeds that. Expedited work is Android's sanctioned way to convert the
 * high-priority-message Doze window into a bounded background execution slot:
 * on Android 12+ it runs as an expedited job (no visible service), on older
 * versions as a short foreground service ({@link #getForegroundInfo}), and
 * WorkManager owns the wake locks so none outlive the work.
 *
 * Coalescing (§5): the work is unique per channel with
 * {@link ExistingWorkPolicy#KEEP}. WorkManager persists enqueued work across
 * processes, so even when each FCM delivery cold-starts a fresh process, a
 * burst of N signals for one channel lands on one pending job → one backend
 * boot and one notification (whose stable per-channel id also makes any later
 * update replace, not stack).
 *
 * Failure behaviour (§4): whatever goes wrong — no config URL, boot failure,
 * offline sync timeout, or WorkManager stopping the job — a generic
 * content-free "New messages" notification is still posted, so the doorbell
 * always rings. A watchdog covers even a wedged blocking boot call.
 *
 * Privacy: no message content, channel name, or sender ever reaches FCM or
 * logcat. Log lines carry at most the opaque channel id (already logged by the
 * JS path today); notification text is composed from local decrypted state.
 */
public class PushWakeWorker extends Worker {

    private static final String TAG = "PushWake";

    static final String KEY_CHANNEL_ID = "channelId";
    static final String KEY_KIND = "kind";

    /** Time budget for boot + channel sync before falling back to generic text. */
    private static final long SYNC_DEADLINE_MS = 25_000;
    /** Poll period against the loopback API while waiting for the channel. */
    private static final long POLL_INTERVAL_MS = 2_000;
    /**
     * After the channel is known, keep the backend up briefly so HeadSync can
     * pull the message bodies too — a tap then opens a populated conversation.
     */
    private static final long LINGER_MS = 6_000;
    /** Absolute worst-case: watchdog rings the generic doorbell at this point. */
    private static final long WATCHDOG_FALLBACK_MS = 30_000;
    /** Per-request HTTP timeouts against 127.0.0.1 (generous: first index build). */
    private static final int HTTP_TIMEOUT_MS = 5_000;

    /** Foreground-service notification id (pre-Android-12 expedited path only). */
    private static final int SYNC_FOREGROUND_ID = 0x4d5750; // "MWP"

    /** Set once a visible notification for this wake has been posted. */
    private final AtomicBoolean posted = new AtomicBoolean(false);

    public PushWakeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /**
     * Enqueue a wake for one channel. Unique-per-channel + KEEP is the §5
     * cross-process coalescing latch (see class doc).
     */
    static void enqueue(Context context, String channelId, String kind) {
        Data input = new Data.Builder()
            .putString(KEY_CHANNEL_ID, channelId)
            .putString(KEY_KIND, kind)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(PushWakeWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(input)
            .build();
        WorkManager.getInstance(context.getApplicationContext())
            .enqueueUniqueWork("push-wake:" + channelId, ExistingWorkPolicy.KEEP, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        String channelId = getInputData().getString(KEY_CHANNEL_ID);
        String kind = getInputData().getString(KEY_KIND);
        if (channelId == null || channelId.isEmpty()) {
            return Result.success();
        }
        Context context = getApplicationContext();
        MatouNotificationChannels.ensure(context);

        // Watchdog: Mobile.start blocks and cannot be interrupted from Java, so
        // a wedged boot would otherwise mean a silent drop. Ring generic instead.
        ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
        watchdog.schedule(() -> {
            if (posted.compareAndSet(false, true)) {
                postNotification(context, channelId, kind, null);
            }
        }, WATCHDOG_FALLBACK_MS, TimeUnit.MILLISECONDS);

        MatouBackendRunner runner = MatouBackendRunner.get();
        runner.acquireHeadlessLease();
        try {
            String channelName = null;
            try {
                String configServerUrl = MatouBackendRunner.configServerUrlFromAssets(context);
                if (configServerUrl.isEmpty()) {
                    Log.e(TAG, "no configServerUrl baked into the app — generic fallback");
                } else {
                    MatouBackendRunner.Info info =
                        runner.start(context, configServerUrl, /* fromApp= */ false);
                    channelName = waitForChannelName(info, channelId);
                }
            } catch (Exception e) {
                // Boot or sync failure (offline, config server unreachable, …).
                Log.e(TAG, "headless wake failed for channel " + channelId, e);
            }

            posted.set(true);
            postNotification(context, channelId, kind, channelName);

            if (channelName != null && !isStopped()) {
                // Channel metadata is here; give HeadSync one more cycle for the
                // message bodies before tearing the backend down.
                SystemClock.sleep(LINGER_MS);
            }
        } finally {
            watchdog.shutdownNow();
            runner.releaseHeadlessLease();
        }
        return Result.success();
    }

    @Override
    public void onStopped() {
        // WorkManager cut us off (quota/Doze). §4: the doorbell still rings.
        String channelId = getInputData().getString(KEY_CHANNEL_ID);
        String kind = getInputData().getString(KEY_KIND);
        if (channelId != null && !channelId.isEmpty() && posted.compareAndSet(false, true)) {
            postNotification(getApplicationContext(), channelId, kind, null);
        }
    }

    /**
     * Poll the loopback chat API until the channel named by the wake payload is
     * visible locally (i.e. its tree has synced), or the deadline passes.
     * Returns the channel's display name, or null on timeout/unknown.
     *
     * The LIST endpoint is used deliberately: it rebuilds the space index on
     * each call (see ChatHandler.HandleListChannels), which is what discovers a
     * P2P-received tree the device has never seen before — a first DM from a
     * new conversation. GETs pass TokenGuard without auth; the token is sent
     * anyway for forward-compat.
     */
    private String waitForChannelName(MatouBackendRunner.Info info, String channelId) {
        long deadline = SystemClock.elapsedRealtime() + SYNC_DEADLINE_MS;
        while (SystemClock.elapsedRealtime() < deadline && !isStopped()) {
            try {
                String body = httpGet(
                    "http://127.0.0.1:" + info.port + "/api/v1/chat/channels",
                    info.token);
                JSONArray channels = new JSONObject(body).optJSONArray("channels");
                if (channels != null) {
                    for (int i = 0; i < channels.length(); i++) {
                        JSONObject channel = channels.getJSONObject(i);
                        if (channelId.equals(channel.optString("id"))) {
                            String name = channel.optString("name", "");
                            return name.isEmpty() ? null : name;
                        }
                    }
                }
            } catch (Exception e) {
                // Backend still warming up or transient error — keep polling.
                Log.d(TAG, "channel poll not ready: " + e.getClass().getSimpleName());
            }
            SystemClock.sleep(POLL_INTERVAL_MS);
        }
        return null;
    }

    private static String httpGet(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int status = conn.getResponseCode();
            if (status != 200) {
                throw new IllegalStateException("HTTP " + status);
            }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }
            return sb.toString();
        } finally {
            conn.disconnect();
        }
    }

    /**
     * Post the wake notification. Same stable per-channel id, Android channel,
     * and tap-intent shape as the JS-posted ones (usePush.presentLocalNotification
     * via @capacitor/local-notifications), so:
     *  - a later JS-posted notification for the same chat channel REPLACES this
     *    one (§7 duplicate suppression), and
     *  - a tap is parsed by LocalNotificationsPlugin.handleOnNewIntent exactly
     *    like a JS-posted notification's tap, firing localNotificationActionPerformed
     *    with {@code notification.extra.c} → the /chat?c=<id> deep-link (§6).
     *
     * @param channelName local decrypted display name, or null → generic §4 text.
     */
    private static void postNotification(
            Context context, String channelId, String kind, String channelName) {
        String title = channelName != null ? "New message in " + channelName : "New messages";
        String androidChannel = "dm".equals(kind)
            ? MatouNotificationChannels.DM
            : MatouNotificationChannels.CHANNEL;
        int id = hashChannelId(channelId);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, androidChannel)
            .setSmallIcon(R.drawable.ic_stat_matou)
            .setColor(context.getColor(R.color.matou_notification))
            .setContentTitle(title)
            .setAutoCancel(true)
            .setPriority("dm".equals(kind)
                ? NotificationCompat.PRIORITY_HIGH
                : NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(buildTapIntent(context, id, channelId));

        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(context);
            if (nm.areNotificationsEnabled()) {
                nm.notify(id, builder.build());
            }
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked mid-flight — nothing to ring.
            Log.w(TAG, "notification permission missing", e);
        }
    }

    /**
     * Build the tap PendingIntent with the exact extras
     * LocalNotificationManager.buildIntent puts on a JS-posted notification, so
     * the Capacitor plugin's handleOnNewIntent → localNotificationActionPerformed
     * path treats both identically (cold start included — BridgeActivity.onCreate
     * forwards the launch intent to onNewIntent).
     */
    private static PendingIntent buildTapIntent(Context context, int id, String channelId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(LocalNotificationManager.NOTIFICATION_INTENT_KEY, id);
        // "tap" mirrors the plugin's private DEFAULT_PRESS_ACTION.
        intent.putExtra(LocalNotificationManager.ACTION_INTENT_KEY, "tap");
        intent.putExtra(LocalNotificationManager.NOTIFICATION_OBJ_INTENT_KEY,
            notificationSourceJson(id, channelId));
        intent.putExtra(LocalNotificationManager.NOTIFICATION_IS_REMOVABLE_KEY, true);

        int flags = PendingIntent.FLAG_CANCEL_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getActivity(context, id, intent, flags);
    }

    /**
     * The JSON handed back to JS as {@code action.notification} — mirrors the
     * shape usePush schedules ({@code extra: {c: channelId}} is what the JS tap
     * handler reads for the deep-link).
     */
    private static String notificationSourceJson(int id, String channelId) {
        try {
            JSONObject extra = new JSONObject().put("c", channelId);
            return new JSONObject().put("id", id).put("extra", extra).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /**
     * Deterministic per-channel notification id — the exact Java twin of
     * usePush.ts hashChannelId (31-multiplier 32-bit rolling hash, then
     * |abs| % 2^31-1), so a JS-posted notification replaces a headless one.
     * Channel ids are ASCII, where charCodeAt(i) == charAt(i).
     */
    static int hashChannelId(String channelId) {
        int h = 0;
        for (int i = 0; i < channelId.length(); i++) {
            h = h * 31 + channelId.charAt(i); // wraps like `| 0` in JS
        }
        // JS Math.abs(-2^31) is 2^31 (no int overflow there) — go through long.
        return (int) (Math.abs((long) h) % 2147483647L);
    }

    /**
     * Foreground-service form of the expedited work, used only below Android 12.
     * A silent minimal notification on the dedicated sync channel; dataSync type
     * (declared in the manifest) is what this work is.
     */
    @NonNull
    @Override
    public ForegroundInfo getForegroundInfo() {
        Context context = getApplicationContext();
        MatouNotificationChannels.ensure(context);
        Notification notification =
            new NotificationCompat.Builder(context, MatouNotificationChannels.SYNC)
                .setSmallIcon(R.drawable.ic_stat_matou)
                .setContentTitle("Checking for new messages")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new ForegroundInfo(SYNC_FOREGROUND_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(SYNC_FOREGROUND_ID, notification);
    }
}
