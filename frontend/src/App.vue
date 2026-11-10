<template>
  <TitleBar />
  <div v-if="electron" class="titlebar-spacer" />
  <UpdateBanner />
  <UpdateNoticeBanner />
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import TitleBar from 'src/components/base/TitleBar.vue';
import UpdateBanner from 'src/components/base/UpdateBanner.vue';
import UpdateNoticeBanner from 'src/components/base/UpdateNoticeBanner.vue';
import { isElectron } from 'src/lib/platform';

const electron = isElectron();

onMounted(() => {
  if (electron) {
    document.documentElement.style.setProperty('--titlebar-height', '36px');
  }
});
</script>

<style>
:root {
  --titlebar-height: 0px;
  /* Height of the mobile bottom tab bar (excluding the bottom safe-area inset).
     Shared token so the chat view can reserve matching space (#168). */
  --bottom-nav-height: 64px;
  /* The device's top inset (the Android status bar in an edge-to-edge WebView;
     0 on web/Electron). Every page clears the status bar through this token
     rather than env() directly, because when the update notice is showing it
     sits at the very top, pads itself by the inset, and zeroes this token so
     the page below it does not clear the status bar a second time. */
  --matou-safe-area-top: env(safe-area-inset-top);
}

html.has-update-notice {
  --matou-safe-area-top: 0px;
}

.titlebar-spacer {
  height: var(--titlebar-height);
  flex-shrink: 0;
}
</style>
