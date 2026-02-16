import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  getChannels,
  getMessages,
  sendMessage as apiSendMessage,
  editMessage as apiEditMessage,
  deleteMessage as apiDeleteMessage,
  addReaction as apiAddReaction,
  removeReaction as apiRemoveReaction,
  createChannel as apiCreateChannel,
  updateChannel as apiUpdateChannel,
  archiveChannel as apiArchiveChannel,
  getThread,
  getReadCursors,
  updateReadCursor as apiUpdateReadCursor,
  type Channel,
  type ChatMessage,
  type CreateChannelRequest,
  type UpdateChannelRequest,
  type SendMessageRequest,
} from 'src/lib/api/chat';

export const useChatStore = defineStore('chat', () => {
  // State
  const channels = ref<Channel[]>([]);
  const currentChannelId = ref<string | null>(null);
  const messages = ref<Map<string, ChatMessage[]>>(new Map());
  const loadingChannels = ref(false);
  const loadingMessages = ref(false);
  const sendingMessage = ref(false);
  const error = ref<string | null>(null);
  const messageCursors = ref<Map<string, string>>(new Map());
  const hasMoreMessages = ref<Map<string, boolean>>(new Map());
  const readCursors = ref<Record<string, string>>({});

  // Computed
  const currentChannel = computed(() => {
    if (!currentChannelId.value) return null;
    return channels.value.find(c => c.id === currentChannelId.value) ?? null;
  });

  const currentMessages = computed(() => {
    if (!currentChannelId.value) return [];
    return messages.value.get(currentChannelId.value) ?? [];
  });

  const sortedChannels = computed(() => {
    return [...channels.value].sort((a, b) => {
      // Archived channels go to the bottom
      if (a.isArchived && !b.isArchived) return 1;
      if (!a.isArchived && b.isArchived) return -1;
      // Sort by name
      return a.name.localeCompare(b.name);
    });
  });

  const unreadCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const channel of channels.value) {
      const cursor = readCursors.value[channel.id];
      if (!cursor) {
        // Channel never visited — count is 0 (no retroactive unreads)
        counts[channel.id] = 0;
        continue;
      }
      // Count messages in this channel newer than the cursor
      const channelMsgs = messages.value.get(channel.id);
      if (!channelMsgs) {
        counts[channel.id] = 0;
        continue;
      }
      counts[channel.id] = channelMsgs.filter(m => m.sentAt > cursor && !m.deletedAt).length;
    }
    return counts;
  });

  const totalUnreadCount = computed(() => {
    return Object.values(unreadCounts.value).reduce((sum, count) => sum + count, 0);
  });

  // Actions
  async function loadChannels(): Promise<void> {
    loadingChannels.value = true;
    error.value = null;
    try {
      channels.value = await getChannels();
      console.log(`[ChatStore] Loaded ${channels.value.length} channels`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load channels';
      console.error('[ChatStore] Failed to load channels:', err);
    } finally {
      loadingChannels.value = false;
    }
  }

  async function selectChannel(channelId: string | null): Promise<void> {
    currentChannelId.value = channelId;
    if (channelId) {
      await loadMessages(channelId);
      await markChannelRead(channelId);
    }
  }

  async function loadMessages(channelId: string, loadMore = false): Promise<void> {
    loadingMessages.value = true;
    error.value = null;

    try {
      const cursor = loadMore ? messageCursors.value.get(channelId) : undefined;
      const response = await getMessages(channelId, { limit: 50, cursor });

      const existingMessages = loadMore ? (messages.value.get(channelId) ?? []) : [];
      // Messages come sorted descending (newest first), so append for "load more"
      const updatedMessages = loadMore
        ? [...existingMessages, ...response.messages]
        : response.messages;

      messages.value.set(channelId, updatedMessages);
      messageCursors.value.set(channelId, response.nextCursor);
      hasMoreMessages.value.set(channelId, response.hasMore);

      console.log(`[ChatStore] Loaded ${response.messages.length} messages for channel ${channelId}`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load messages';
      console.error('[ChatStore] Failed to load messages:', err);
    } finally {
      loadingMessages.value = false;
    }
  }

  async function loadMoreMessages(): Promise<void> {
    if (!currentChannelId.value) return;
    if (!hasMoreMessages.value.get(currentChannelId.value)) return;
    await loadMessages(currentChannelId.value, true);
  }

  async function sendMessage(content: string, options?: { replyTo?: string }): Promise<boolean> {
    if (!currentChannelId.value) return false;

    sendingMessage.value = true;
    error.value = null;

    try {
      const request: SendMessageRequest = { content };
      if (options?.replyTo) {
        request.replyTo = options.replyTo;
      }

      const result = await apiSendMessage(currentChannelId.value, request);
      if (!result.success) {
        error.value = result.error ?? 'Failed to send message';
        return false;
      }

      // Optimistically add message (will be confirmed via SSE)
      // For now, just reload messages
      await loadMessages(currentChannelId.value);
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to send message';
      console.error('[ChatStore] Failed to send message:', err);
      return false;
    } finally {
      sendingMessage.value = false;
    }
  }

  async function editMessage(messageId: string, content: string): Promise<boolean> {
    error.value = null;

    try {
      const result = await apiEditMessage(messageId, content);
      if (!result.success) {
        error.value = result.error ?? 'Failed to edit message';
        return false;
      }

      // Update message in local state
      if (currentChannelId.value) {
        const channelMessages = messages.value.get(currentChannelId.value);
        if (channelMessages) {
          const idx = channelMessages.findIndex(m => m.id === messageId);
          if (idx !== -1) {
            channelMessages[idx] = {
              ...channelMessages[idx],
              content,
              editedAt: result.editedAt,
            };
          }
        }
      }

      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to edit message';
      return false;
    }
  }

  async function deleteMessage(messageId: string): Promise<boolean> {
    error.value = null;

    try {
      const result = await apiDeleteMessage(messageId);
      if (!result.success) {
        error.value = result.error ?? 'Failed to delete message';
        return false;
      }

      // Update message in local state (soft delete - mark as deleted)
      if (currentChannelId.value) {
        const channelMessages = messages.value.get(currentChannelId.value);
        if (channelMessages) {
          const idx = channelMessages.findIndex(m => m.id === messageId);
          if (idx !== -1) {
            channelMessages[idx] = {
              ...channelMessages[idx],
              deletedAt: new Date().toISOString(),
            };
          }
        }
      }

      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to delete message';
      return false;
    }
  }

  async function toggleReaction(messageId: string, emoji: string): Promise<boolean> {
    // Find the message and check if user has already reacted
    let hasReacted = false;
    if (currentChannelId.value) {
      const channelMessages = messages.value.get(currentChannelId.value);
      const message = channelMessages?.find(m => m.id === messageId);
      if (message?.reactions) {
        const reaction = message.reactions.find(r => r.emoji === emoji);
        hasReacted = reaction?.hasReacted ?? false;
      }
    }

    try {
      if (hasReacted) {
        const result = await apiRemoveReaction(messageId, emoji);
        if (!result.success) {
          error.value = result.error ?? 'Failed to remove reaction';
          return false;
        }
      } else {
        const result = await apiAddReaction(messageId, emoji);
        if (!result.success) {
          error.value = result.error ?? 'Failed to add reaction';
          return false;
        }
      }

      // Reload messages to get updated reactions
      if (currentChannelId.value) {
        await loadMessages(currentChannelId.value);
      }

      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to toggle reaction';
      return false;
    }
  }

  async function loadThread(messageId: string): Promise<ChatMessage[]> {
    try {
      const result = await getThread(messageId);
      return result.replies ?? [];
    } catch (err) {
      console.error('[ChatStore] Failed to load thread:', err);
      return [];
    }
  }

  // Admin actions
  async function createChannel(request: CreateChannelRequest): Promise<string | null> {
    error.value = null;

    try {
      const result = await apiCreateChannel(request);
      if (!result.success) {
        error.value = result.error ?? 'Failed to create channel';
        return null;
      }

      // Reload channels
      await loadChannels();
      return result.channelId ?? null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to create channel';
      return null;
    }
  }

  async function updateChannel(channelId: string, request: UpdateChannelRequest): Promise<boolean> {
    error.value = null;

    try {
      const result = await apiUpdateChannel(channelId, request);
      if (!result.success) {
        error.value = result.error ?? 'Failed to update channel';
        return false;
      }

      // Reload channels
      await loadChannels();
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to update channel';
      return false;
    }
  }

  async function archiveChannel(channelId: string): Promise<boolean> {
    error.value = null;

    try {
      const result = await apiArchiveChannel(channelId);
      if (!result.success) {
        error.value = result.error ?? 'Failed to archive channel';
        return false;
      }

      // Reload channels
      await loadChannels();

      // Clear current channel if it was archived
      if (currentChannelId.value === channelId) {
        currentChannelId.value = null;
      }

      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to archive channel';
      return false;
    }
  }

  async function loadReadCursors(): Promise<void> {
    try {
      readCursors.value = await getReadCursors();
      console.log('[ChatStore] Loaded read cursors:', Object.keys(readCursors.value).length);
    } catch (err) {
      console.error('[ChatStore] Failed to load read cursors:', err);
    }
  }

  async function loadAllChannelMessages(): Promise<void> {
    try {
      const promises = channels.value.map(async (channel) => {
        if (!messages.value.has(channel.id)) {
          const response = await getMessages(channel.id, { limit: 50 });
          messages.value.set(channel.id, response.messages);
        }
      });
      await Promise.all(promises);
      console.log('[ChatStore] Loaded messages for all channels');
    } catch (err) {
      console.error('[ChatStore] Failed to load all channel messages:', err);
    }
  }

  async function markChannelRead(channelId: string): Promise<void> {
    const channelMsgs = messages.value.get(channelId);
    // Use latest message's sentAt, or current time if no messages
    const lastReadAt = channelMsgs?.length
      ? channelMsgs.reduce((latest, m) => m.sentAt > latest ? m.sentAt : latest, channelMsgs[0].sentAt)
      : new Date().toISOString();

    readCursors.value = { ...readCursors.value, [channelId]: lastReadAt };

    try {
      await apiUpdateReadCursor(channelId, lastReadAt);
    } catch (err) {
      console.error('[ChatStore] Failed to update read cursor:', err);
    }
  }

  // SSE event handlers
  function handleNewMessage(data: {
    messageId: string;
    channelId: string;
    senderAid: string;
    senderName: string;
    content: string;
    sentAt: string;
  }): void {
    // Ensure the channel's message list exists in the store
    if (!messages.value.has(data.channelId)) {
      messages.value.set(data.channelId, []);
    }

    const channelMessages = messages.value.get(data.channelId)!;

    // Check if message already exists
    if (channelMessages.some(m => m.id === data.messageId)) return;

    // Add new message at the beginning (newest first)
    channelMessages.unshift({
      id: data.messageId,
      channelId: data.channelId,
      senderAid: data.senderAid,
      senderName: data.senderName,
      content: data.content,
      sentAt: data.sentAt,
      version: 1,
    });

    // If this is the active channel, auto-mark as read
    if (data.channelId === currentChannelId.value) {
      markChannelRead(data.channelId);
    }
  }

  function handleEditMessage(data: {
    messageId: string;
    channelId: string;
    content: string;
    editedAt: string;
  }): void {
    const channelMessages = messages.value.get(data.channelId);
    if (!channelMessages) return;

    const idx = channelMessages.findIndex(m => m.id === data.messageId);
    if (idx !== -1) {
      channelMessages[idx] = {
        ...channelMessages[idx],
        content: data.content,
        editedAt: data.editedAt,
      };
    }
  }

  function handleDeleteMessage(data: {
    messageId: string;
    channelId: string;
    deletedAt: string;
  }): void {
    const channelMessages = messages.value.get(data.channelId);
    if (!channelMessages) return;

    const idx = channelMessages.findIndex(m => m.id === data.messageId);
    if (idx !== -1) {
      channelMessages[idx] = {
        ...channelMessages[idx],
        deletedAt: data.deletedAt,
      };
    }
  }

  function handleNewChannel(data: { channelId: string; name: string }): void {
    // Reload channels to get full data
    loadChannels();
  }

  function handleUpdateChannel(data: { channelId: string }): void {
    // Reload channels to get full data
    loadChannels();
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    // State
    channels,
    currentChannelId,
    messages,
    loadingChannels,
    loadingMessages,
    sendingMessage,
    error,
    readCursors,

    // Computed
    currentChannel,
    currentMessages,
    sortedChannels,
    unreadCounts,
    totalUnreadCount,

    // Actions
    loadChannels,
    selectChannel,
    loadMessages,
    loadMoreMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    loadThread,
    createChannel,
    updateChannel,
    archiveChannel,
    clearError,
    loadReadCursors,
    loadAllChannelMessages,
    markChannelRead,

    // SSE handlers
    handleNewMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleNewChannel,
    handleUpdateChannel,
  };
});
