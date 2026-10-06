# matou-mcp

A local stdio MCP server that lets Claude Code interact with a running Matou app:
read/write projects and contributions, drive the contribution workflow, post chat
messages, and create notices (events / announcements / updates).

## Setup

```bash
cd matou-mcp
npm install
npm run build
```

Register it in Claude Code by adding the contents of `.mcp.json.example` to the
`.mcp.json` at the repo root, then restart Claude Code.

## Configuration (env vars, all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `MATOU_BACKEND_URL` | auto-discovered (`ss` on Linux, `lsof` on macOS; each matou-backend port is probed and the one whose `/health` is the Matou API wins) | Point at a specific backend (e.g. `http://127.0.0.1:9080` for test) |
| `MATOU_USER_AID` | the running backend's identity (`GET /api/v1/identity`), else `aid` from a plaintext `identity.json` in the data dir | Identity for RBAC-gated (project/contribution) tools |
| `MATOU_API_TOKEN` | dev/test backends: fixed `matou-dev` constant; prod: `api-token` in the data dir (rewritten every app launch) | Bearer token the backend's TokenGuard requires on mutating requests |
| `MATOU_DATA_DIR` | `~/.config/Matou/matou-data` (Linux), `~/Library/Application Support/Matou/matou-data` (macOS), `%APPDATA%\Matou\matou-data` (Windows) | Where to find the packaged app's `api-token` / `identity.json` — set it for a kit build with a different productName |
| `MATOU_READONLY` | unset | Set to `1` to hide all mutating tools (query-only) |

With the defaults, nothing needs updating after an app restart — the port and API token are rediscovered each time the MCP server starts. Run `matou_status` first to confirm the target environment and acting identity.

## Identity note

Chat and notice tools post as the **running app's** identity, not `MATOU_USER_AID`.
The override only affects RBAC-gated project/contribution tools.

## Development

```bash
npm test          # unit tests (vitest)
npm run dev       # run via tsx without building
```
