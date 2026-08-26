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
| `MATOU_BACKEND_URL` | auto-discovered via `ss` | Point at a specific backend (e.g. `http://127.0.0.1:9080` for test) |
| `MATOU_USER_AID` | `aid` from `~/.config/Matou/matou-data/identity.json` | Identity for RBAC-gated (project/contribution) tools |
| `MATOU_API_TOKEN` | dev/test backends: fixed `matou-dev` constant; prod: `~/.config/Matou/matou-data/api-token` | Bearer token the backend's TokenGuard requires on mutating requests |
| `MATOU_READONLY` | unset | Set to `1` to hide all mutating tools (query-only) |

Run `matou_status` first to confirm the target environment and acting identity.

## Identity note

Chat and notice tools post as the **running app's** identity, not `MATOU_USER_AID`.
The override only affects RBAC-gated project/contribution tools.

## Development

```bash
npm test          # unit tests (vitest)
npm run dev       # run via tsx without building
```
