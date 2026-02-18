# Matou App - Deployment Guide

Build and release the Matou desktop app for Linux, macOS, and Windows.

## Prerequisites

- **Go** 1.21+ (backend compilation)
- **Node.js** 18/20/22/24 with npm
- **Quasar CLI**: `npm install -g @quasar/cli`
- **glab** (optional, for CLI-based releases): `https://gitlab.com/gitlab-org/cli`

## Quick Build (Current Platform)

```bash
# 1. Build backend binary for your platform
cd backend
make build-linux-amd64    # or build-darwin-arm64, build-darwin-amd64, build-windows-amd64

# 2. Create .env.production
cd ../frontend
cp .env.production.example .env.production
# Edit with your config server URL

# 3. Build the Electron app
npm install
npx quasar build -m electron
```

Output: `frontend/dist/electron/Packaged/`

## Step-by-Step Build

### 1. Build Backend Binaries

The Go backend must be cross-compiled for each target platform before packaging.

```bash
cd backend

# Individual platform builds
make build-linux-amd64        # → bin/linux-amd64/matou-backend
make build-darwin-arm64       # → bin/darwin-arm64/matou-backend     (macOS Apple Silicon)
make build-darwin-amd64       # → bin/darwin-amd64/matou-backend     (macOS Intel)
make build-windows-amd64      # → bin/windows-amd64/matou-backend.exe

# Or build all at once
make build-all
```

The Electron build copies everything from `backend/bin/` into the app's resources directory. Only the binary matching the target platform is used at runtime.

### 2. Configure Production Environment

Create `frontend/.env.production` with your deployment settings:

```env
VITE_ENV=prod
VITE_PROD_CONFIG_URL=http://awa.matou.nz:3904
```

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_ENV` | Yes | Must be `prod` for production builds |
| `VITE_PROD_CONFIG_URL` | Yes | Config server URL (provides KERI URLs, witness OOBIs, any-sync config) |
| `VITE_SMTP_HOST` | No | SMTP server for email invites |
| `VITE_SMTP_PORT` | No | SMTP port for email invites |

These values are injected at **build time** into the Electron main process via esbuild `define` in `quasar.config.ts`. They cannot be changed after packaging.

### 3. Build the Electron App

```bash
cd frontend
npm install
npx quasar build -m electron
```

This builds the frontend, compiles the Electron main process, and packages for the **current platform**.

#### Cross-Platform Builds (from Linux)

To build Windows and macOS packages from a Linux machine, first run the standard build (which compiles the UI and Electron main process), then use electron-builder with the cross-build config:

```bash
# 1. Standard build (compiles UI + packages for current platform)
npx quasar build -m electron

# 2. Build Windows installer
npx electron-builder --win --config build/electron-builder-cross.json

# 3. Build macOS zips (one arch at a time to avoid filename collision)
npx electron-builder --mac zip --x64 --config build/electron-builder-cross.json
mv dist/electron/Packaged/matou-*.zip dist/electron/Packaged/matou-0.0.1-mac-x64.zip

npx electron-builder --mac zip --arm64 --config build/electron-builder-cross.json
mv dist/electron/Packaged/matou-*.zip dist/electron/Packaged/matou-0.0.1-mac-arm64.zip
```

The cross-build config (`build/electron-builder-cross.json`) mirrors the settings from `quasar.config.ts` (app ID, product name, extra resources, icons) so that electron-builder can run independently.

Output: `frontend/dist/electron/Packaged/`

## Platform Details

### Linux (AppImage)

**Output**: `matou-{version}.AppImage`

**Sandbox workaround**: AppImages run via FUSE mounts where SUID sandbox binaries don't work. The `build/afterPack.cjs` hook automatically creates a wrapper script that launches the app with `--no-sandbox`. This is the same approach used by VS Code, Brave, and other Electron apps distributed as AppImages.

**Desktop integration**: On first launch, the app installs:
- Icons to `~/.local/share/icons/hicolor/{size}x{size}/apps/matou.png`
- A `.desktop` file to `~/.local/share/applications/matou.desktop`

**Data directory**: `~/.config/Matou/matou-data`

**Run**:
```bash
chmod +x matou-*.AppImage
./matou-*.AppImage
```

### macOS (zip)

**Output**: `matou-{version}.zip`

Unzip to get the `.app` bundle. The app is currently **unsigned** — users will need to right-click and select "Open" on first launch, or remove the quarantine attribute:

```bash
xattr -cr Matou.app
```

**Data directory**: `~/Library/Application Support/Matou/matou-data`

**Supported architectures**:
- Apple Silicon (M1/M2/M3/M4): requires `build-darwin-arm64`
- Intel: requires `build-darwin-amd64`

### Windows (NSIS installer)

**Output**: `matou-{version}.exe`

Standard NSIS installer. The app is currently **unsigned** — Windows SmartScreen may show a warning on first run.

**Data directory**: `%APPDATA%/Matou/matou-data`

## Creating a Release

### Update the Version

Update the version in `frontend/package.json` before building:

```json
{
  "version": "0.1.0"
}
```

The version is used in output filenames (e.g. `matou-0.1.0.AppImage`).

### Build All Platforms

From a Linux machine, you can build all platforms using the cross-build config:

```bash
# Build all backend binaries
cd backend && make build-all

# Build frontend + Linux package
cd ../frontend && npm install && npx quasar build -m electron

# Cross-build Windows and macOS
npx electron-builder --win --config build/electron-builder-cross.json

npx electron-builder --mac zip --x64 --config build/electron-builder-cross.json
mv dist/electron/Packaged/matou-0.1.0.zip dist/electron/Packaged/matou-0.1.0-mac-x64.zip

npx electron-builder --mac zip --arm64 --config build/electron-builder-cross.json
mv dist/electron/Packaged/matou-0.1.0.zip dist/electron/Packaged/matou-0.1.0-mac-arm64.zip
```

**macOS note**: Both architectures output `matou-{version}.zip`, so build them separately and rename to include the architecture (`-mac-x64` / `-mac-arm64`) before uploading.

### Tag the Release

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

### Authenticate glab

Releases are managed via the `glab` CLI. Authenticate with a [Personal Access Token](https://gitlab.com/-/user_settings/personal_access_tokens) that has the `api` scope:

```bash
glab auth login --token <your-token> --hostname gitlab.com
```

### Upload via glab (CLI)

Packaged artifacts (AppImage, exe, zip) typically exceed GitLab's 100 MB direct upload limit. Use the **Generic Package Registry** to upload files, then link them to the release.

**1. Create the release:**

```bash
glab release create v0.1.0 \
  --title "Matou v0.1.0" \
  --notes "Release notes here"
```

**2. Upload artifacts to the Generic Package Registry:**

```bash
# Get your token (create a PAT at https://gitlab.com/-/user_settings/personal_access_tokens)
TOKEN="<your-gitlab-pat>"
VERSION="0.1.0"
PACKAGED="frontend/dist/electron/Packaged"
REGISTRY="https://gitlab.com/api/v4/projects/78188786/packages/generic/matou/${VERSION}"

# Upload each artifact
curl --header "PRIVATE-TOKEN: $TOKEN" \
  --upload-file "${PACKAGED}/matou-${VERSION}.AppImage" \
  "${REGISTRY}/matou-${VERSION}.AppImage"

curl --header "PRIVATE-TOKEN: $TOKEN" \
  --upload-file "${PACKAGED}/matou-${VERSION}.exe" \
  "${REGISTRY}/matou-${VERSION}.exe"

curl --header "PRIVATE-TOKEN: $TOKEN" \
  --upload-file "${PACKAGED}/matou-${VERSION}-mac-arm64.zip" \
  "${REGISTRY}/matou-${VERSION}-mac-arm64.zip"

curl --header "PRIVATE-TOKEN: $TOKEN" \
  --upload-file "${PACKAGED}/matou-${VERSION}-mac-x64.zip" \
  "${REGISTRY}/matou-${VERSION}-mac-x64.zip"
```

Upload only the artifacts you've built. Each successful upload returns `{"message":"201 Created"}`.

**Re-uploading**: Uploading to the same registry URL replaces the file. The release asset links remain unchanged, so you only need to re-run the curl upload commands — no need to update the release links.

**3. Link artifacts to the release (first release only):**

This step is only needed when creating a new release. If you're updating artifacts for an existing release, skip this — re-uploading to the same registry URL replaces the file and the links stay the same.

```bash
RELEASES="https://gitlab.com/api/v4/projects/78188786/releases/v${VERSION}/assets/links"

# Linux
curl --header "PRIVATE-TOKEN: $TOKEN" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "{\"name\":\"Linux (AppImage)\",\"url\":\"${REGISTRY}/matou-${VERSION}.AppImage\",\"link_type\":\"package\"}" \
  "${RELEASES}"

# Windows
curl --header "PRIVATE-TOKEN: $TOKEN" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "{\"name\":\"Windows (Installer)\",\"url\":\"${REGISTRY}/matou-${VERSION}.exe\",\"link_type\":\"package\"}" \
  "${RELEASES}"

# macOS Apple Silicon
curl --header "PRIVATE-TOKEN: $TOKEN" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "{\"name\":\"macOS Apple Silicon (zip)\",\"url\":\"${REGISTRY}/matou-${VERSION}-mac-arm64.zip\",\"link_type\":\"package\"}" \
  "${RELEASES}"

# macOS Intel
curl --header "PRIVATE-TOKEN: $TOKEN" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "{\"name\":\"macOS Intel (zip)\",\"url\":\"${REGISTRY}/matou-${VERSION}-mac-x64.zip\",\"link_type\":\"package\"}" \
  "${RELEASES}"
```

### Upload via GitLab Web UI

1. Go to https://gitlab.com/matou-collective/matou-app/-/releases
2. Click **New release** (or edit an existing one)
3. Choose the tag (e.g. `v0.1.0`) or create a new one
4. Add a title and release notes
5. Upload artifacts to the Generic Package Registry using the curl commands above
6. Under **Release assets**, click **Add another link** for each artifact:
   - **Link title**: `Linux (AppImage)`, `Windows (Installer)`, `macOS Apple Silicon (zip)`, or `macOS Intel (zip)`
   - **URL**: The package registry URL (e.g. `https://gitlab.com/api/v4/projects/78188786/packages/generic/matou/0.1.0/matou-0.1.0.AppImage`)
   - **Type**: Select **Package**
7. Click **Create release**

## How It Works

### Backend Lifecycle

The Electron main process spawns the Go backend as a child process:

1. Finds a free port dynamically
2. Locates the backend binary at `resources/backend/{platform}-{arch}/matou-backend`
3. Spawns it with environment variables (`MATOU_SERVER_PORT`, `MATOU_DATA_DIR`, etc.)
4. Polls `/health` until the backend is ready (up to 30 seconds)
5. Opens the app window pointing to `http://127.0.0.1:{port}`
6. Kills the backend on app exit

### Config Server

In production mode, the backend fetches its any-sync network configuration from the config server URL (`MATOU_CONFIG_SERVER_URL`). The config is cached locally at `config/client-production.yml` after the first fetch.

The config server provides:
- any-sync network configuration (coordinator, file nodes, tree nodes)
- KERI witness OOBIs
- Organization endpoints

### Directory Structure After Build

```
frontend/dist/electron/Packaged/
├── linux-unpacked/                     # Unpacked Linux app
│   ├── matou                           # Shell wrapper (--no-sandbox)
│   ├── matou.bin                       # Real Electron binary
│   └── resources/
│       ├── app.asar                    # Bundled frontend + electron main
│       ├── backend/                    # All backend binaries
│       │   ├── linux-amd64/matou-backend
│       │   ├── darwin-arm64/matou-backend
│       │   ├── darwin-amd64/matou-backend
│       │   └── windows-amd64/matou-backend.exe
│       └── icons/                      # App icons
├── win-unpacked/                       # Unpacked Windows app
├── mac/Matou.app/                      # Unpacked macOS x64 app
├── mac-arm64/Matou.app/                # Unpacked macOS arm64 app
├── matou-{version}.AppImage            # Linux
├── matou-{version}.exe                 # Windows (NSIS installer)
├── matou-{version}-mac-x64.zip         # macOS Intel (renamed)
└── matou-{version}-mac-arm64.zip       # macOS Apple Silicon (renamed)
```

## Troubleshooting

### Backend binary not found (ENOENT)

```
Error: spawn .../resources/backend/linux-amd64/matou-backend ENOENT
```

The backend wasn't compiled before the Electron build. Run the appropriate `make build-{platform}` target first.

### Config server connection failed

```
Failed to fetch any-sync config from config server
```

Check that `VITE_PROD_CONFIG_URL` in `.env.production` is correct and the config server is reachable. Use `http://` not `https://` if the server doesn't have TLS.

### TLS handshake error

```
tls: first record does not look like a TLS handshake
```

The URL uses `https://` but the server is running plain HTTP. Change to `http://` in `.env.production` and rebuild.

### App exits silently (no window)

If the backend fails to start, the app may exit without showing an error dialog. Run from a terminal to see backend logs:

```bash
./matou-*.AppImage          # Linux
open Matou.app --args       # macOS (view logs in Console.app)
```

### Release upload fails (413 entity too large)

```
POST .../uploads: 413 entity is too large
```

GitLab's direct upload API has a ~100 MB limit. Packaged Electron apps typically exceed this. Use the Generic Package Registry instead (see [Upload via glab](#upload-via-glab-cli) above).

### Linux sandbox errors

```
The SUID sandbox helper binary was found, but is not configured correctly
```

The `afterPack.cjs` hook should handle this automatically. If it didn't run, check that `build/afterPack.cjs` exists and is referenced in `quasar.config.ts` under `builder.afterPack`.
