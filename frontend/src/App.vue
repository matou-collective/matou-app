<template>
  <TitleBar />
  <div v-if="electron" class="titlebar-spacer" />
  <router-view />
</template>

<script setup lang="ts">
import TitleBar from 'src/components/base/TitleBar.vue';
import { isElectron } from 'src/lib/platform';

const electron = isElectron();
</script>

<style>
.titlebar-spacer {
  height: 36px;
  flex-shrink: 0;
}
</style>
