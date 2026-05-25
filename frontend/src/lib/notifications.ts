/**
 * OS-level notification helper.
 *
 * Bridges renderer-side events to either Electron's main-process Notification
 * (preferred, via the preload `electronAPI` bridge) or the browser HTML5
 * Notification API (fallback for `quasar dev` web mode and dev-sessions.sh).
 * Skips firing when the window is already focused — the in-app Quasar toast
 * covers that case.
 */

export interface NotifyOptions {
  title: string;
  body: string;
  // Opaque route hint passed back to the click handler.
  data?: Record<string, string>;
  // Show even when the window is focused. Default false — assume in-app toast handles it.
  whenFocused?: boolean;
}

type ClickHandler = (data: Record<string, string>) => void;

let clickHandler: ClickHandler | null = null;

function getElectronAPI() {
  return (window as Window).electronAPI;
}

/**
 * Request notification permission upfront. Call once at app startup so the
 * permission prompt fires at a predictable time rather than mid-test on the
 * first event arrival.
 */
export function initNotifications(): void {
  const api = getElectronAPI();
  if (api?.isElectron) {
    // Wire the Electron click bridge once. Falls through to clickHandler set by
    // registerNotificationClickHandler().
    api.onNotificationClicked((data) => {
      clickHandler?.(data);
    });
    return;
  }

  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

export function maybeNotify(opts: NotifyOptions): void {
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  if (visible && !opts.whenFocused) return;

  const api = getElectronAPI();
  if (api?.isElectron) {
    api.notify({ title: opts.title, body: opts.body, data: opts.data });
    return;
  }

  // Browser fallback (covers `quasar dev` web mode + dev-sessions.sh)
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const notification = new Notification(opts.title, { body: opts.body });
  notification.onclick = () => {
    window.focus();
    if (opts.data) clickHandler?.(opts.data);
    notification.close();
  };
}

export function registerNotificationClickHandler(handler: ClickHandler): void {
  clickHandler = handler;
}
