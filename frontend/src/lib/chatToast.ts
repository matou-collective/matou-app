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
export interface ChatMessageNewEvent {
  channelId?: unknown;
  historical?: unknown;
}

export function shouldAnnounceChatMessage(
  event: ChatMessageNewEvent,
  currentChannelId: string | null | undefined,
): boolean {
  if (event.historical === true) return false;
  // Messages in the channel being viewed appear in place.
  return event.channelId !== currentChannelId;
}
