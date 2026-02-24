# Update Notification Banner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace automatic app restart on update with a user-controlled banner that lets them choose when to restart.

**Architecture:** Electron main process sends IPC event to renderer when update is downloaded. Renderer shows a dismissible banner in App.vue. User clicks "Restart Now" to trigger install, or "X" to dismiss for the session.

**Tech Stack:** Electron IPC (ipcMain/ipcRenderer), Vue 3 Composition API, Quasar components

---

### Task 1: Update electron-main.ts — stop auto-restart, add IPC

**Files:**
- Modify: `frontend/src-electron/electron-main.ts:333-361`

**Step 1: Replace the `update-downloaded` handler and add `install-update` IPC**

In `setupAutoUpdater()`, replace the `update-downloaded` listener (line 355-358) so it sends an event to the renderer instead of calling `quitAndInstall()`. Also add an IPC handler so the renderer can trigger install.

```typescript
// In setupAutoUpdater(), replace the update-downloaded handler:

  autoUpdater.on('update-downloaded', () => {
    log.info('[Updater] Update downloaded, notifying renderer');
    mainWindow?.webContents.send('update-downloaded');
  });
```

And add this IPC handler after the existing secure-storage handlers (after line 331), before `setupAutoUpdater()`:

```typescript
ipcMain.handle('install-update', () => {
  log.info('[Updater] User requested install, quitting and installing...');
  autoUpdater.quitAndInstall();
});
```

**Step 2: Verify the change compiles**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx quasar build -m electron 2>&1 | tail -20`

If there are TypeScript errors, fix them. Otherwise, move on.

**Step 3: Commit**

```bash
git add frontend/src-electron/electron-main.ts
git commit -m "feat: replace auto-restart with IPC notification on update download"
```

---

### Task 2: Update electron-preload.ts — expose update APIs to renderer

**Files:**
- Modify: `frontend/src-electron/electron-preload.ts`

**Step 1: Add `onUpdateDownloaded` and `installUpdate` to the exposed API**

Add two new methods to the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object:

```typescript
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on('update-downloaded', () => callback());
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
```

These go after the existing `windowIsMaximized` line (line 18), inside the same object.

**Step 2: Commit**

```bash
git add frontend/src-electron/electron-preload.ts
git commit -m "feat: expose update notification and install APIs to renderer"
```

---

### Task 3: Create UpdateBanner.vue component

**Files:**
- Create: `frontend/src/components/base/UpdateBanner.vue`

**Step 1: Create the component**

```vue
<template>
  <div v-if="visible" class="update-banner">
    <span class="update-banner-text">A new version is available.</span>
    <button class="update-banner-restart" @click="installUpdate">
      Restart Now
    </button>
    <button class="update-banner-dismiss" @click="dismiss" aria-label="Dismiss">
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>
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

function getAPI(): UpdateAPI | null {
  if (!isElectron()) return null;
  return (window as unknown as { electronAPI: UpdateAPI }).electronAPI;
}

function installUpdate() {
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
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.update-banner-dismiss:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}
</style>
```

**Step 2: Commit**

```bash
git add frontend/src/components/base/UpdateBanner.vue
git commit -m "feat: add UpdateBanner component for update notifications"
```

---

### Task 4: Wire UpdateBanner into App.vue

**Files:**
- Modify: `frontend/src/App.vue`

**Step 1: Add UpdateBanner between titlebar-spacer and router-view**

The template should become:

```vue
<template>
  <TitleBar />
  <div v-if="electron" class="titlebar-spacer" />
  <UpdateBanner />
  <router-view />
</template>
```

And the script should import it:

```vue
<script setup lang="ts">
import TitleBar from 'src/components/base/TitleBar.vue';
import UpdateBanner from 'src/components/base/UpdateBanner.vue';
import { isElectron } from 'src/lib/platform';

const electron = isElectron();
</script>
```

No changes to the `<style>` block.

**Step 2: Verify it compiles**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx quasar build -m electron 2>&1 | tail -20`

**Step 3: Commit**

```bash
git add frontend/src/App.vue
git commit -m "feat: wire UpdateBanner into App.vue for app-wide update notifications"
```

---

### Task 5: Manual verification

**Step 1: Run the dev server and check the banner renders correctly**

To test the banner visually during development, temporarily set `visible` to `true` in UpdateBanner.vue:

```typescript
const visible = ref(true); // temporary: force-show for visual testing
```

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx quasar dev -m electron`

Verify:
- Banner appears below the titlebar
- "Restart Now" button is visible
- "X" dismiss button hides the banner
- Content below is pushed down, not overlapped

**Step 2: Revert the temporary change**

Set `visible` back to `false`:

```typescript
const visible = ref(false);
```

**Step 3: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: finalize update banner implementation"
```
