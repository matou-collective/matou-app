package nz.matou.app;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Process-wide "is the app UI alive?" signal for the closed-app push wake
 * (#421, docs/architecture/08-push-notifications.md §5).
 *
 * {@link MatouMessagingService} must decide, on an FCM data message, whether the
 * WebView bridge can deliver the signal to JS (normal path — delegate to the
 * Capacitor push plugin) or whether the process was cold-started by FCM and the
 * headless wake has to run instead. The signal is a simple static counter that
 * {@link MainActivity} increments in {@code onCreate} and decrements in
 * {@code onDestroy}.
 *
 * Why this is reliable:
 *
 * <ul>
 *   <li>The FCM service runs in the app's default process (no
 *       {@code android:process} in the manifest), so it shares these statics
 *       with the activity.</li>
 *   <li>A swipe-away / OS kill destroys the whole process; the next FCM
 *       delivery cold-starts a fresh process where the counter is 0 — exactly
 *       the state in which JS delivery is impossible.</li>
 *   <li>A gracefully finished activity (back press) runs {@code onDestroy} and
 *       drops the counter to 0; the WebView is gone with it, so JS delivery
 *       would silently no-op — headless is correct there too.</li>
 *   <li>While the activity exists in ANY lifecycle state (foreground,
 *       backgrounded, stopped-in-recents) the counter is &gt; 0 and the
 *       Capacitor push plugin can deliver: either immediately
 *       ({@code staticBridge} is set) or via its {@code lastMessage} stash,
 *       which {@code PushNotificationsPlugin.load()} re-fires once the bridge
 *       finishes booting. That covers the small startup window where the
 *       activity exists but the plugin has not loaded yet.</li>
 * </ul>
 *
 * The one uncovered edge is a crashed WebView inside a live activity — Android
 * surfaces that as a renderer-gone callback that kills the activity in
 * practice, and the pre-#421 behaviour in that state was identical (dropped
 * signal), so it is not a regression.
 */
public final class MatouAppState {

    private static final AtomicInteger createdActivities = new AtomicInteger(0);

    private MatouAppState() {}

    /** Called from {@link MainActivity#onCreate}. */
    static void onActivityCreated() {
        createdActivities.incrementAndGet();
    }

    /** Called from {@link MainActivity#onDestroy}. */
    static void onActivityDestroyed() {
        // Never drop below zero even if lifecycle callbacks misbehave. CAS loop
        // instead of updateAndGet: that is an API-24 method and minSdk is 23.
        int n;
        do {
            n = createdActivities.get();
        } while (n > 0 && !createdActivities.compareAndSet(n, n - 1));
    }

    /**
     * True while at least one {@link MainActivity} instance exists — i.e. the
     * WebView bridge is (or is about to be) able to deliver push signals to JS.
     */
    public static boolean isUiAlive() {
        return createdActivities.get() > 0;
    }
}
