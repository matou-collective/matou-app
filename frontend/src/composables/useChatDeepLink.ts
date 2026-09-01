/**
 * `/chat?c=<channelId>` deep-link handling for push-notification taps
 * (docs/architecture/08-push-notifications.md §6).
 *
 * Reading the query on mount alone is not enough: a tap that arrives while
 * ChatPage is already mounted only changes the route query, so without a watch
 * the notification does nothing at all — the single most visible failure of the
 * deep-link contract. This composable applies the link now (via the returned
 * `applyDeepLink`, which the page calls once its channels are loaded) and on
 * every later change of the query.
 *
 * The reactive source and the channel lookup are injected so the logic is
 * testable without a router or a mounted component.
 */

import { watch } from 'vue';

export interface ChatDeepLinkOptions {
  /** Reactive getter for the target channel id (`route.query.c`), or null. */
  channelId: () => string | null;
  /** Whether the channel is known locally — an unknown id is ignored. */
  isKnown: (channelId: string) => boolean;
  /** Select the channel. */
  select: (channelId: string) => void | Promise<void>;
}

export interface ChatDeepLink {
  /**
   * Apply the current deep-link if there is one and the channel is known.
   * Returns whether a channel was selected, so callers can skip their own
   * auto-selection.
   */
  applyDeepLink: () => Promise<boolean>;
}

export function useChatDeepLink(options: ChatDeepLinkOptions): ChatDeepLink {
  const applyDeepLink = async (): Promise<boolean> => {
    const id = options.channelId();
    if (!id || !options.isKnown(id)) return false;
    await options.select(id);
    return true;
  };

  // A tap while the page is mounted changes only the query — react to it.
  watch(options.channelId, () => {
    void applyDeepLink();
  });

  return { applyDeepLink };
}
