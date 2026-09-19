/**
 * Whether an incoming `chat:message:new` event should be announced to the user
 * (in-app toast + OS notification), as opposed to only updating the chat store.
 *
 * The backend flags a message `historical` when it is new to THIS device but was
 * sent a while ago: a device pulling a space from scratch — a fresh link, a
 * recovery, a re-synced store — receives every message ever sent, and so does a
 * device coming back online. Those still update the store and unread counts;
 * announcing each one buried the app under a toast per historical message on
 * every launch (#556).
 */
export interface HistoricalMarkedEvent {
  historical?: unknown;
}

/**
 * Whether a P2P backend event should be announced to the user (toast + OS
 * notification) at all, as opposed to only updating a store. The backend stamps
 * every event `historical` when it reflects a change pulled during a cold sync
 * (a fresh link, a recovery, a re-synced store) rather than a live one, so no
 * announce path floods the user with pre-existing trees regardless of which
 * event types raise a toast (#559). A missing or malformed flag means live —
 * older backends send none, and unknown age keeps the old behaviour.
 */
export function shouldAnnounce(event: HistoricalMarkedEvent): boolean {
  return event.historical !== true;
}

export interface ChatMessageNewEvent extends HistoricalMarkedEvent {
  channelId?: unknown;
}

export function shouldAnnounceChatMessage(
  event: ChatMessageNewEvent,
  currentChannelId: string | null | undefined,
): boolean {
  if (!shouldAnnounce(event)) return false;
  // Messages in the channel being viewed appear in place.
  return event.channelId !== currentChannelId;
}
