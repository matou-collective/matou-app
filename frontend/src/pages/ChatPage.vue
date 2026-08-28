<template>
  <div class="chat-page" :style="pageStyle">
    <ChatLayout />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import ChatLayout from 'src/components/chat/ChatLayout.vue';
import { useChatStore } from 'stores/chat';
import { useIsMobile } from 'src/composables/useIsMobile';
import { useVisualViewport } from 'src/composables/useVisualViewport';

const chatStore = useChatStore();
const isMobile = useIsMobile();
const viewportHeight = useVisualViewport();

// On mobile, pin the chat column to the *visible* viewport so the message list
// and composer shrink together when the soft keyboard opens — otherwise the
// fixed-100vh column keeps its height and the first messages end up hidden
// behind the keyboard (#125). Desktop/web keeps the static CSS height.
// The column starts below DashboardLayout's top safe-area padding, so subtract
// that inset or the composer overshoots the visible viewport by exactly the
// status-bar height once the keyboard is open (env() is 0 on web/Electron).
const pageStyle = computed(() =>
  isMobile.value && viewportHeight.value != null
    ? { height: `calc(${viewportHeight.value}px - env(safe-area-inset-top))` }
    : {}
);

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
