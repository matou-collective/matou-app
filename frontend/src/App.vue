<template>
  <TitleBar />
  <div v-if="electron" class="titlebar-spacer" />
  <UpdateBanner />
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import TitleBar from 'src/components/base/TitleBar.vue';
import UpdateBanner from 'src/components/base/UpdateBanner.vue';
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
}

.titlebar-spacer {
  height: var(--titlebar-height);
  flex-shrink: 0;
}
</style>
