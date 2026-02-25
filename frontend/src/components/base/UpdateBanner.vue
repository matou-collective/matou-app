<template>
  <div v-if="visible" class="update-banner">
    <span class="update-banner-text">A new version is available.</span>
    <button class="update-banner-restart" @click="installUpdate" :disabled="restarting">
      {{ restarting ? 'Restarting...' : 'Restart Now' }}
    </button>
    <button class="update-banner-dismiss" @click="dismiss">Dismiss</button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { isElectron } from 'src/lib/platform';

interface UpdateAPI {
  onUpdateDownloaded: (callback: () => void) => void;
  installUpdate: () => Promise<void>;
}

const visible = ref(false);
const restarting = ref(false);

function getAPI(): UpdateAPI | null {
  if (!isElectron()) return null;
  return (window as unknown as { electronAPI: UpdateAPI }).electronAPI;
}

function installUpdate() {
  restarting.value = true;
  getAPI()?.installUpdate();
}

function dismiss() {
  visible.value = false;
}

onMounted(() => {
  getAPI()?.onUpdateDownloaded(() => {
    visible.value = true;
  });
});
</script>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 6px 16px;
  background: #1a7f8a;
  color: #ffffff;
  font-size: 13px;
  flex-shrink: 0;
}

.update-banner-text {
  font-weight: 500;
}

.update-banner-restart {
  padding: 3px 12px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.update-banner-restart:hover {
  background: rgba(255, 255, 255, 0.25);
}

.update-banner-dismiss {
  padding: 3px 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.update-banner-dismiss:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}
</style>
