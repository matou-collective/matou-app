<template>
  <div class="chat-layout">
    <!-- Channel Sidebar -->
    <ChannelSidebar
      :channels="chatStore.sortedChannels"
      :currentChannelId="chatStore.currentChannelId"
      :loading="chatStore.loadingChannels"
      @select="handleSelectChannel"
      @create="showCreateModal = true"
    />

    <!-- Main Chat Area -->
    <div class="chat-main">
      <template v-if="chatStore.currentChannel">
        <ChannelHeader
          :channel="chatStore.currentChannel"
          @settings="showSettingsModal = true"
        />
        <MessageList
          :messages="chatStore.currentMessages"
          :loading="chatStore.loadingMessages"
          :hasMore="hasMoreMessages"
          :lastReadAt="chatStore.channelEntryReadAt"
          @loadMore="handleLoadMore"
          @reply="handleReply"
          @edit="handleEditStart"
          @delete="handleDelete"
          @react="handleReact"
        />
        <MessageComposer
          ref="composerRef"
          :channelId="chatStore.currentChannelId!"
          :replyTo="replyingTo"
          :sending="chatStore.sendingMessage"
          @send="handleSend"
          @cancelReply="replyingTo = null"
        />
      </template>
      <div v-else class="no-channel">
        <div class="no-channel-content">
          <MessageSquare class="no-channel-icon" />
          <h2>Select a channel</h2>
          <p>Choose a channel from the sidebar to start chatting</p>
        </div>
      </div>
    </div>

    <!-- Thread Panel (when viewing a thread) -->
    <ThreadPanel
      v-if="threadMessageId"
      :messageId="threadMessageId"
      @close="threadMessageId = null"
    />

    <!-- Modals -->
    <CreateChannelModal
      v-if="showCreateModal"
      @close="showCreateModal = false"
      @created="handleChannelCreated"
    />

    <ChannelSettingsModal
      v-if="showSettingsModal && chatStore.currentChannel"
      :channel="chatStore.currentChannel"
      @close="showSettingsModal = false"
      @updated="handleChannelUpdated"
    />

    <!-- Edit Message Modal -->
    <EditMessageModal
      v-if="editingMessage"
      :message="editingMessage"
      @close="editingMessage = null"
      @save="handleEditSave"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { MessageSquare } from 'lucide-vue-next';
import { useChatStore } from 'stores/chat';
import type { ChatMessage, AttachmentRef } from 'src/lib/api/chat';

import ChannelSidebar from './ChannelSidebar.vue';
import ChannelHeader from './ChannelHeader.vue';
import MessageList from './MessageList.vue';
import MessageComposer from './MessageComposer.vue';
import ThreadPanel from './ThreadPanel.vue';
import CreateChannelModal from './CreateChannelModal.vue';
import ChannelSettingsModal from './ChannelSettingsModal.vue';
import EditMessageModal from './EditMessageModal.vue';

const chatStore = useChatStore();

const composerRef = ref<InstanceType<typeof MessageComposer> | null>(null);

// UI State
const showCreateModal = ref(false);
const showSettingsModal = ref(false);
const replyingTo = ref<ChatMessage | null>(null);
const editingMessage = ref<ChatMessage | null>(null);
const threadMessageId = ref<string | null>(null);

const hasMoreMessages = computed(() => {
  if (!chatStore.currentChannelId) return false;
  // Access the Map directly from the store
  return false; // Will be updated when we have hasMore in store
});

// Handlers
async function handleSelectChannel(channelId: string) {
  await chatStore.selectChannel(channelId);
  replyingTo.value = null;
  threadMessageId.value = null;
}

async function handleLoadMore() {
  await chatStore.loadMoreMessages();
}

function handleReply(message: ChatMessage) {
  replyingTo.value = message;
}

function handleEditStart(message: ChatMessage) {
  editingMessage.value = message;
}

async function handleEditSave(messageId: string, content: string) {
  const success = await chatStore.editMessage(messageId, content);
  if (success) {
    editingMessage.value = null;
  }
}

async function handleDelete(message: ChatMessage) {
  if (confirm('Are you sure you want to delete this message?')) {
    await chatStore.deleteMessage(message.id);
  }
}

async function handleReact(messageId: string, emoji: string) {
  await chatStore.toggleReaction(messageId, emoji);
}

async function handleSend(content: string, attachments?: AttachmentRef[]) {
  await chatStore.sendMessage(content, { replyTo: replyingTo.value?.id, attachments });
  replyingTo.value = null;
  nextTick(() => composerRef.value?.focus());
}

function handleChannelCreated(channelId: string) {
  showCreateModal.value = false;
  chatStore.selectChannel(channelId);
}

function handleChannelUpdated() {
  showSettingsModal.value = false;
}
</script>

<style lang="scss" scoped>
.chat-layout {
  display: flex;
  width: 100%;
  height: 100%;
  background-color: var(--matou-background);
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background-color: var(--matou-card);
}

.no-channel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.no-channel-content {
  text-align: center;
  color: var(--matou-muted-foreground);

  h2 {
    margin: 1rem 0 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--matou-foreground);
  }

  p {
    margin: 0;
    font-size: 0.875rem;
  }
}

.no-channel-icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}
</style>
