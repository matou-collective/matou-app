# Update Notification Banner

## Problem

When a new version is downloaded, Electron immediately calls `autoUpdater.quitAndInstall()`, restarting the app without user consent. Users should control when the restart happens.

## Design

### Architecture

Three touch points:

1. **`electron-main.ts`** — Stop auto-restarting. Send IPC event to renderer when update downloaded. Expose `install-update` handler.
2. **`electron-preload.ts`** — Add `onUpdateDownloaded(callback)` and `installUpdate()` to exposed API.
3. **`App.vue` + `UpdateBanner.vue`** — Show a dismissible banner app-wide (below titlebar) when update is ready.

### Banner Behavior

- Full-width bar below the titlebar, pushes content down (not overlay)
- Text: "A new version is available."
- "Restart Now" button (small, prominent)
- "X" close button on the right
- Dismissed banners stay hidden until next app launch (session-scoped state)
- Appears on all screens (onboarding, dashboard, etc.)

### Data Flow

```
Main Process                    Preload                     Renderer (App.vue)
update-downloaded event --> onUpdateDownloaded(cb) --> showBanner = true
                            installUpdate()        <-- User clicks "Restart Now"
                                                       User clicks "X" --> showBanner = false
```

### Files Changed

| File | Change |
|------|--------|
| `electron-main.ts` | Remove `quitAndInstall()` from `update-downloaded`. Add `ipcMain.handle('install-update')`. Send event to renderer via `webContents.send()`. |
| `electron-preload.ts` | Add `onUpdateDownloaded(cb)` and `installUpdate()` to exposed API. |
| `App.vue` | Add `<UpdateBanner />` between titlebar-spacer and router-view. |
| `components/base/UpdateBanner.vue` (new) | Banner component with text, restart button, close button. |

### State Management

No Pinia store needed. A single `ref<boolean>` in UpdateBanner.vue, set by the IPC callback. Session-scoped — resets on app restart.
