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
  chatStore.selectChannel(null);
});

onMounted(async () => {
  await chatStore.loadChannels();
  await chatStore.loadReadCursors();
  await chatStore.loadAllChannelMessages();

  // Auto-select: last visited channel (localStorage) > first channel (if no unreads)
  if (!chatStore.currentChannelId && chatStore.channels.length > 0) {
    const lastChannelId = localStorage.getItem('matou:lastChannelId');
    const lastExists = lastChannelId && chatStore.channels.some(c => c.id === lastChannelId);

    if (lastExists) {
      await chatStore.selectChannel(lastChannelId!);
    } else if (chatStore.totalUnreadCount === 0) {
      await chatStore.selectChannel(chatStore.channels[0].id);
    }
  }
});
</script>

<style lang="scss" scoped>
.chat-page {
  height: calc(100vh - var(--titlebar-height));
  display: flex;
  overflow: hidden;
  width: 100%;
}
</style>
