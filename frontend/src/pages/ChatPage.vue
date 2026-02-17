<template>
  <div class="chat-page">
    <ChatLayout />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import ChatLayout from 'src/components/chat/ChatLayout.vue';
import { useChatStore } from 'stores/chat';

const chatStore = useChatStore();

onUnmounted(() => {
  console.log('[ChatPage] unmounted, clearing active channel');
  chatStore.selectChannel(null);
});

onMounted(async () => {
  console.log('[ChatPage] mounted, channels already loaded:', chatStore.channels.length);
  await chatStore.loadChannels();
  await chatStore.loadReadCursors();
  await chatStore.loadAllChannelMessages();
  console.log('[ChatPage] Data loaded. Channels:', chatStore.channels.length, 'Cursors:', JSON.stringify(chatStore.readCursors), 'Total unread:', chatStore.totalUnreadCount);

  // Auto-select first channel only if none selected AND no unread messages.
  // When there are unreads, let the user see the sidebar badges first.
  if (!chatStore.currentChannelId && chatStore.channels.length > 0) {
    if (chatStore.totalUnreadCount === 0) {
      console.log('[ChatPage] No unreads, auto-selecting first channel');
      await chatStore.selectChannel(chatStore.channels[0].id);
    } else {
      console.log('[ChatPage] Has unreads, skipping auto-select');
    }
  }
});
</script>

<style lang="scss" scoped>
.chat-page {
  height: 100vh;
  display: flex;
  overflow: hidden;
  width: 100%;
}
</style>
