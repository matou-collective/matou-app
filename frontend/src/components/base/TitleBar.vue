<template>
  <div v-if="showTitleBar" class="titlebar">
    <div class="titlebar-drag">
      <span class="titlebar-title">Mātou</span>
    </div>
    <div class="titlebar-controls">
      <button class="titlebar-btn" @click="minimize" aria-label="Minimize">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button class="titlebar-btn" @click="maximize" aria-label="Maximize">
        <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12">
          <rect x="3" y="0.5" width="8.5" height="8.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
          <rect x="0.5" y="3" width="8.5" height="8.5" rx="1" fill="#003141" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button class="titlebar-btn titlebar-btn-close" @click="close" aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { isElectron } from 'src/lib/platform';

const showTitleBar = isElectron();
const isMaximized = ref(false);

interface WindowAPI {
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
}

function getAPI(): WindowAPI | null {
  if (!showTitleBar) return null;
  return (window as unknown as { electronAPI: WindowAPI }).electronAPI;
}

async function minimize() {
  await getAPI()?.windowMinimize();
}

async function maximize() {
  await getAPI()?.windowMaximize();
  isMaximized.value = (await getAPI()?.windowIsMaximized()) ?? false;
}

async function close() {
  await getAPI()?.windowClose();
}

let interval: ReturnType<typeof setInterval>;
onMounted(() => {
  // Poll maximized state (fires on snap/double-click titlebar drag)
  interval = setInterval(async () => {
    isMaximized.value = (await getAPI()?.windowIsMaximized()) ?? false;
  }, 500);
});

onUnmounted(() => {
  clearInterval(interval);
});
</script>

<style scoped>
.titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  height: 36px;
  background: #003141;
  color: #ffffff;
  font-size: 16px;
  font-weight: 500;
  user-select: none;
  flex-shrink: 0;
}

.titlebar-drag {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  -webkit-app-region: drag;
}

.titlebar-title {
}

.titlebar-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: #ffffff;
  cursor: pointer;
  transition: background 0.15s;
}

.titlebar-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.titlebar-btn-close:hover {
  background: #c42b1c;
}
</style>
