<template>
  <div class="chat-page">
    <ChatLayout />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import ChatLayout from 'src/components/chat/ChatLayout.vue';
import { useChatStore } from 'stores/chat';
import { useChatEvents } from 'src/composables/useChatEvents';

const chatStore = useChatStore();
const { connected } = useChatEvents();

onMounted(async () => {
  await chatStore.loadChannels();
  await chatStore.loadReadCursors();
  await chatStore.loadAllChannelMessages();

  // Select first channel if none selected
  if (!chatStore.currentChannelId && chatStore.channels.length > 0) {
    await chatStore.selectChannel(chatStore.channels[0].id);
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
