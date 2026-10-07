<template>
  <div v-if="update" class="update-notice-banner">
    <span class="update-notice-text">A new version is available.</span>
    <button class="update-notice-download" @click="download">Download</button>
    <button class="update-notice-dismiss" @click="dismiss">Dismiss</button>
  </div>
</template>

<script setup lang="ts">
// The Coa update notice for Mac and Android (Matou/coa app-updates spec §4). Windows
// and Linux Coa builds update themselves through UpdateBanner; the Mātou app never
// shows this (noticeTarget returns null for it).
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { KIT } from 'src/generated/kit';
import { getCapacitorPlatform } from 'src/lib/capacitor';
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  noticeTarget,
  readDismissed,
  writeDismissed,
  type AvailableUpdate,
} from 'src/lib/updateNotice';

interface ElectronEnv {
  platform?: string;
  arch?: string;
}

const update = ref<AvailableUpdate | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const electron = (window as unknown as { electronAPI?: ElectronEnv }).electronAPI;
const target = noticeTarget(KIT.slug, {
  electronPlatform: electron?.platform,
  electronArch: electron?.arch,
  capacitorPlatform: getCapacitorPlatform(),
});

async function check() {
  if (!target) return;
  update.value = await checkForUpdate({
    slug: KIT.slug,
    ownBuild: KIT.build,
    target,
    dismissedBuild: readDismissed(storage()),
  });
}

function download() {
  if (!update.value) return;
  // Electron: a _blank window is routed to the OS browser by setWindowOpenHandler.
  // Android: Capacitor hands a navigation to a non-app host to the system, which
  // downloads the APK and offers to install it.
  if (electron) window.open(update.value.url, '_blank');
  else window.location.assign(update.value.url);
}

function dismiss() {
  if (update.value) writeDismissed(storage(), update.value.build);
  update.value = null;
}

onMounted(() => {
  if (!target) return;
  void check();
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.update-notice-banner {
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

.update-notice-text {
  font-weight: 500;
}

.update-notice-download {
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

.update-notice-download:hover {
  background: rgba(255, 255, 255, 0.25);
}

.update-notice-dismiss {
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

.update-notice-dismiss:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}
</style>
