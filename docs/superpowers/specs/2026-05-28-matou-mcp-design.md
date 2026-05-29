# Matou MCP Server — Design Spec

- **Date:** 2026-05-28
- **Status:** Approved (pending written-spec review)
- **Author:** Ben + Claude
- **Supersedes:** the `matou-bulk-create` skill (to be retired once this lands)

## 1. Goal

Let Claude interact conversationally with a running Matou app — reading and writing
across the projects/contributions lifecycle, posting chat messages, and creating
notices (events / announcements / updates) — through a local MCP server exposed to
Claude Code.

Today this is done via the `matou-bulk-create` skill: a playbook of `curl` calls plus
hard-won domain knowledge. That approach is brittle (Claude must sequence multi-step
workflows correctly and remember gotchas). This server moves that knowledge into
**smart tools** that encode the rules server-side, so the model calls clean,
high-level operations and the server enforces ordering, RBAC, enums, and state
transitions.

## 2. Locked-in decisions

| Decision | Choice |
|---|---|
| Scope | Full conversational read + write across the projects/contributions lifecycle, plus chat messages and notices |
| Client | Claude Code CLI |
| Transport | stdio (local) |
| Tool style | Smart tools that encode rules; the skill is retired |
| Language/runtime | TypeScript + official `@modelcontextprotocol/sdk` (Node) |
| Backend discovery | `MATOU_BACKEND_URL` env override; else auto-discover the running `matou-backend` port and confirm via `/health` |
| Acting identity | `MATOU_USER_AID` env override; else read `aid` from `~/.config/Matou/matou-data/identity.json` |
| Location | New `matou-mcp/` directory inside the `matou-app` repo |

## 3. Architecture

A standalone Node/TypeScript process speaks MCP over **stdio** to Claude Code. On
startup it:

1. **Resolves the backend URL** — `MATOU_BACKEND_URL` if set; otherwise scans for the
   listening `matou-backend` process (e.g. `ss -tlnp | grep matou-backend`) and
   confirms with `GET /health`.
2. **Resolves the acting AID** — `MATOU_USER_AID` if set; otherwise reads `aid` from
   `~/.config/Matou/matou-data/identity.json`.
3. Registers the tool catalog and serves requests.

Every RBAC-gated mutating call sends the acting AID in the `X-User-AID` header. Every
response body is parsed for an `error` field — the HTTP status code is never trusted
on its own (see §7).

```
Claude Code  --stdio (MCP)-->  matou-mcp (Node/TS)
                                     |  HTTP + X-User-AID
                                     v
                       http://127.0.0.1:<port>  (Matou backend / AppImage)
```

### Identity nuance (important)

Two different identity mechanisms exist in the backend:

- **RBAC-gated endpoints** (projects, implementation-plans, milestones, contributions,
  and their workflow transitions) read the **`X-User-AID` header**. The
  `MATOU_USER_AID` override controls these.
- **Chat and notices** post as the backend's **own configured identity**
  (`userIdentity.GetAID()`), ignoring the header. `MATOU_USER_AID` does **not** change
  who chat messages / notices are attributed to — they are always the running app's
  user. For Ben operating his own app this is a non-issue, but it must be documented so
  nobody expects `MATOU_USER_AID` to "post as someone else" in chat.

## 4. Tool catalog (v1, ~20 tools)

Scoped to projects/contributions + chat + notices. Governance, proposals, trust,
credentials, and spaces are intentionally **out of scope for v1** (§12).

### 4.1 Meta / reads (no RBAC)

| Tool | Backend call | Notes |
|---|---|---|
| `matou_status` | `GET /health` + discovery state | Reports backend URL, target env (prod/dev/test), acting AID + display name, readonly flag, health |
| `list_projects` | `GET /api/v1/projects` | id, title, status, lead, steward |
| `get_project` | `GET /api/v1/projects/{id}` + plan + contributions | Hydrated view: plan, milestones, contributions |
| `list_my_tasks` | `GET /api/v1/projects/{id}/contributions` (across projects) | Contributions assigned/offered to the acting AID, grouped by status |
| `list_contributions` | `GET /api/v1/projects/{id}/contributions` | Filter by status / assignee / milestone |
| `get_contribution` | `GET /api/v1/contributions/{id}` | Full detail |
| `resolve_member` | `GET /api/v1/profiles`, `/profiles/PrivateProfile`, project roles, `/community/members` | name ↔ AID directory; used internally and exposed for "who is X" |

### 4.2 Create — projects / plans / milestones / contributions (RBAC: `X-User-AID`)

| Tool | Backend call | Notes |
|---|---|---|
| `create_project` | `POST /api/v1/projects` (+ optional `POST /api/v1/implementation-plans`) | title, description, optional lead/steward (by name or AID), optional dates. Can create the implementation plan in the same call |
| `add_milestone` | `POST /api/v1/implementation-plans/{id}/milestones` | title, duration, optional start/end dates (applied per ordering rule §6) |
| `add_contribution` | `POST /api/v1/contributions` | project + milestone, validated `contribution_type`, priority, title, description, objectives, deliverables, acceptance_criteria, skill_requirements, optional assignee (name/AID), budget, deadline, estimated hours |

### 4.3 Workflow — contribution state machine (RBAC: `X-User-AID`)

| Tool | Backend call(s) | Notes |
|---|---|---|
| `offer_contribution` | `POST .../transition` (→confirmed) then `POST .../offer` | Handles `created→confirmed→offered`; enforces the deadline-before-confirm gate; resolves offeree name→AID |
| `assign_contribution` | `POST .../assign` | Assign to a member (name/AID) |
| `submit_for_review` | `POST .../submit-evidence` | completion_notes, evidence_urls, acceptance_notes, actual hours, actual amount. Requires status `assigned`; fractional-hours fallback (§6) |
| `review_contribution` | `POST .../review` | decision = approved / incomplete / declined + notes (lead/steward) |
| `sign_off_contribution` | `POST .../sign-off` | `approved→signed_off` |
| `archive_contribution` | `POST .../archive` | Flagged as irreversible in description |

### 4.4 Chat (posts as the backend's own identity)

| Tool | Backend call | Notes |
|---|---|---|
| `list_channels` | `GET /api/v1/chat/channels` | id, name — for resolving a channel by name |
| `send_message` | `POST /api/v1/chat/channels/{channelId}/messages` | `content` (required unless attachments), optional `replyTo` for threading. Resolves channel by name or id |

### 4.5 Notices — events / announcements / updates (posts as the backend's own identity)

| Tool | Backend call | Notes |
|---|---|---|
| `list_notices` | `GET /api/v1/notices` | Filter by type / view (upcoming/current/past) |
| `create_notice` | `POST /api/v1/notices` | `type` = `event` \| `update` \| `announcement` (validated); title + summary required; optional body; create as `draft` or publish immediately. For `event`: eventStart, eventEnd, timezone, locationMode/Text/Url, rsvpEnabled/Required/Capacity. Optional ackRequired/ackDueAt and activeFrom/activeUntil |
| `publish_notice` | publish transition on `/api/v1/notices/{id}` | Publish an existing draft (`draft→published`) |

## 5. Reference: enums and shapes

- **`contribution_type`** (validated): `coding_technical_dev`, `coordination_operations`,
  `discussion_community_input`, `research_knowledge`, `art_design`, `cultural_oversight`,
  `follow_learn` (legacy values `technical`, `community`, `governance`, `operations` also
  accepted but discouraged).
- **`priority`**: `low`, `medium`, `high`, `critical`.
- **Review decision**: `approved`, `incomplete`, `declined`.
- **Notice `type`**: `event`, `update`, `announcement`. **Notice `state`**: `draft`,
  `published`.
- **Contribution state machine** (subset the tools drive):
  `created→confirmed→offered→assigned→needs_review→approved→signed_off`; re-offer from
  `assigned` requires `assigned→changed→confirmed` first.
- **`SendMessageRequest`**: `content`, `attachments[]`, `replyTo`.
- **`CreateNoticeRequest`**: `type`, `title`, `summary`, `body?`, `state?`, plus the
  event/ack/active fields listed above (camelCase JSON keys).

## 6. Rules the server enforces (smart-tool logic)

These encode the gotchas discovered while operating via the skill, so the model cannot
get them wrong:

1. **Auto `X-User-AID`** on every RBAC-gated call. (`POST /api/v1/projects` returns
   `401` without it; a plain client gets a body with no `id` → silent `null`.)
2. **Enum validation before send** — `contribution_type`, notice `type`, `state`,
   `priority`, review decision. Unknown value → tool error listing valid options.
3. **Name→AID resolution** for assignee / offeree / lead / steward via the members
   directory. Ambiguous or unresolved → return an error asking the user to
   disambiguate. **Never invent a placeholder AID** (they get stored as-is and silently
   break the assignee UI).
4. **Creation ordering** — when a milestone is given both dates and contributions in
   one flow: create milestone → create contributions → **then** PUT the dates. Setting
   dates first lets a subsequent contribution-create overwrite the plan's inline
   milestone copy and wipe them.
5. **Deadline-before-confirm gate** — `offer_contribution` ensures a deadline is set
   before confirming (the backend rejects confirm without one).
6. **Fractional-hours fallback** — `submit_for_review` sends `actual_duration` as given.
   If the backend rejects a fractional value with `invalid request body` (builds before
   the `int→float64` fix), retry with the rounded integer and append the exact
   `X hrs @ $rate = $amount` derivation to `completion_notes`; report to the user what
   was done. `actual_cost` is float-safe and always sent exactly.
7. **Parse every response body** — surface backend `error` text; never report success
   off the HTTP status code alone.

## 7. Error handling

Map backend errors to actionable tool errors:

| Condition | Message |
|---|---|
| `401` X-User-AID required | "Identity not configured — open the Matou app or set `MATOU_USER_AID`." |
| `403` RBAC | "You lack the role required for this action (need project_lead / steward / founding_member)." |
| `400` validation | Echo the backend's validation message verbatim. |
| `409` conflict | Explain (e.g. blocking child contributions: list the blocking IDs). |
| Backend not found | "No running matou-backend found — is the Matou app open? Or set `MATOU_BACKEND_URL`." |
| identity.json unreadable | "Couldn't read identity.json — set `MATOU_USER_AID`." |

## 8. Safety (writing to production from chat)

- `matou_status` always reports the **target environment** — derived from the port
  (`8080`=dev, `9080`=test, dynamic=prod AppImage) — and the acting identity, so the
  user always knows what they are about to mutate.
- **`MATOU_READONLY=1`** hides all mutating tools (create/workflow/chat/notice writes),
  leaving only reads — for querying prod with zero write risk.
- v1 exposes **archive only**; no project hard-delete tool. Archive and other
  irreversible actions are flagged in their tool descriptions.

## 9. Project layout

```
matou-mcp/
  package.json        tsconfig.json        README.md
  .mcp.json.example   (registration snippet for Claude Code)
  src/
    index.ts          server bootstrap, stdio transport, tool registration
    backend.ts        port discovery + HTTP client (adds X-User-AID, parses errors)
    identity.ts       identity.json / env → acting AID + env detection
    members.ts        name <-> AID directory (profiles + project roles + members)
    rules.ts          enums, state machine, ordering, fractional-hours fallback
    types.ts          request/response shapes mirrored from the Go API
    tools/
      meta.ts         matou_status
      projects.ts     list/get/create project, add_milestone, add_contribution
      contributions.ts list/get/list_my_tasks, resolve_member
      workflow.ts     offer/assign/submit/review/sign_off/archive
      chat.ts         list_channels, send_message
      notices.ts      list_notices, create_notice, publish_notice
  tests/
    rules.test.ts     unit: enums, ordering, fractional-hours, AID resolution, errors
    smoke.test.ts     integration against TEST backend (9080) only
```

## 10. Testing

- **Unit (vitest), HTTP mocked:** name→AID resolution, enum validation, ordering logic,
  fractional-hours fallback, error mapping.
- **Smoke (integration):** runs **only** against the test backend (port `9080`,
  `MATOU_ENV=test`) and refuses to run if the discovered env is prod. Creates a
  throwaway project, exercises create → offer → submit → review → sign-off, then
  **hard-deletes** the project to clean up.
- **Manual:** register in Claude Code; run `matou_status`, `list_my_tasks`, create a
  draft notice, send a test chat message.

## 11. Registration in Claude Code

Project-scoped `.mcp.json` at the `matou-app` repo root:

```json
{
  "mcpServers": {
    "matou": {
      "command": "node",
      "args": ["./matou-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

- Build: `npm run build` (tsc → `dist/`). Dev: `npx tsx src/index.ts`.
- Optional env overrides: `MATOU_BACKEND_URL`, `MATOU_USER_AID`, `MATOU_READONLY`.
- README documents setup and the overrides.

## 12. Out of scope (v1)

Governance actions, proposals, decision-plans, trust graph, credentials, spaces,
channel creation/admin, message edit/delete/reactions, RSVPs/acks, file uploads. All
are addable later as new tool modules without changing the architecture.

## 13. Skill retirement

Once the tools are implemented and verified against a real backend, remove the
`matou-bulk-create` skill. Its domain knowledge survives in `rules.ts` (the encoded
gotchas) and the `matou-mcp/README.md`.

## 14. Open questions / future

- Generate `types.ts` from the Go structs (or a contract test) to prevent drift — a
  recurring class of bug (silently dropped fields). For v1, hand-mirror the shapes and
  add a smoke test; revisit codegen if drift bites.
- Add a confirmation affordance for production writes if conversational mutation proves
  too easy to trigger accidentally.
