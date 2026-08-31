<template>
  <div class="chat-page" :class="{ 'reserve-tab-bar': reserveTabBar }" :style="pageStyle">
    <ChatLayout />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import ChatLayout from 'src/components/chat/ChatLayout.vue';
import { useChatStore } from 'stores/chat';
import { useIsMobile } from 'src/composables/useIsMobile';
import { useVisualViewport } from 'src/composables/useVisualViewport';
import { useKeyboardOpen } from 'src/composables/useKeyboardOpen';

const chatStore = useChatStore();
const route = useRoute();
const isMobile = useIsMobile();
const viewportHeight = useVisualViewport();
const keyboardOpen = useKeyboardOpen();

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

// On mobile the fixed bottom tab bar overlays the viewport, so reserve matching
// space below the chat column or the composer renders behind it and cannot be
// tapped (#168). While the keyboard is open the tab bar hides (#126), so drop
// the reservation to give the list/composer the full visible viewport (#125).
const reserveTabBar = computed(() => isMobile.value && !keyboardOpen.value);

onUnmounted(() => {
  chatStore.selectChannel(null);
});

onMounted(async () => {
  await chatStore.loadChannels();
  await chatStore.loadReadCursors();
  await chatStore.loadAllChannelMessages();

  // Deep-link from a push-notification tap (docs/architecture/
  // 08-push-notifications.md §6): /chat?c=<channelId> selects that channel on
  // mount. Query-param form — no router change, does not block on #168.
  const deepLinkChannel = Array.isArray(route.query.c) ? route.query.c[0] : route.query.c;
  if (deepLinkChannel && chatStore.channels.some(c => c.id === deepLinkChannel)) {
    await chatStore.selectChannel(deepLinkChannel);
    return;
  }

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
  box-sizing: border-box;
}

// Mobile: keep the composer clear of the fixed bottom tab bar + bottom safe
// area (#168). The height above (100vh or the visual viewport) covers the whole
// screen including the area the tab bar overlays, so subtract the bar via
// bottom padding; box-sizing keeps the flex children (list + composer) inside
// it. Removed while the keyboard is open, when the tab bar is hidden (#126).
.chat-page.reserve-tab-bar {
  padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
}
</style>
