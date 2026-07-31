# In-app Issue Reporting to Forgejo — Design

**Date:** 2026-07-30
**Status:** Approved pending user review
**Repos touched:** `matou-app` (frontend only), `matou-infrastructure` (config-server.py)

## Purpose

Let any Matou app user report a bug or suggest an improvement from inside the app,
creating a real issue in the Forgejo repo at `https://git.matou.nz/Matou/matou-app`.
Users have no Forgejo accounts, and Forgejo has no email-to-issue feature (open
feature request forgejo#4845), so issues are created via the Forgejo REST API using
a bot token. The token lives only on the config server (awa.matou.nz), which proxies
issue creation — no credentials ship with the app.

## Architecture

```
Frontend (ReportIssueDialog)
    │  POST {configServerUrl}/api/v1/issues   {type, title, description, context}
    ▼
Config server (config-server.py, matou-infrastructure)
    │  validates + rate-limits, holds FORGEJO_TOKEN
    │  POST https://git.matou.nz/api/v1/repos/Matou/matou-app/issues
    ▼
Forgejo → returns {number, html_url} → relayed to frontend
```

The local Go backend is not involved; the frontend already talks to the config
server directly (`fetchClientConfig()` in `src/lib/clientConfig.ts`), and the config
server already handles a comparable authenticated POST (`/api/send-email` via
Resend).

## Components

### 1. Side nav button (`frontend/src/layouts/DashboardLayout.vue`)

- New button inside `.sidebar-footer`, directly **above** the `.user-profile` div.
- Lucide `Bug` icon + label **"Report an issue"**.
- Styled like a `.nav-item` but visually subtler (muted color, slightly smaller),
  consistent with footer placement. No active-route state — it opens a dialog,
  never navigates.
- Clicking sets a local `showReportDialog` ref; the dialog component is mounted in
  the layout alongside `ProfileModal`.

### 2. Report dialog (`frontend/src/components/common/ReportIssueDialog.vue`)

Quasar `QDialog` with:

- **Type** — toggle: *Bug* | *Improvement* (default Bug).
- **Title** — single-line text, required, max 200 chars.
- **Description** — textarea, required, max 5000 chars. Placeholder: "What
  happened? What did you expect to happen?" (bug) / "What would you like to see?"
  (improvement).
- **Context preview** — a small read-only block showing exactly what will be
  auto-attached (nothing is sent invisibly):
  - App version (`0.3.0` from `package.json`, exposed via Vite define or import)
  - Platform + OS (`navigator.userAgent` summarized; Electron vs web)
  - Environment (`getEnv()` from `clientConfig.ts`)
  - Reporter display name (from the profiles store; "Anonymous" fallback)
- **Actions** — Cancel / Submit. Submit disables the form and shows a spinner.
- **Success state** — replaces the form: "Thanks — logged as issue #N", with the
  issue URL shown as plain text (users have no Forgejo accounts; the link is mainly
  useful for stewards). Close button.
- **Error state** — inline banner above the form (form stays filled so nothing is
  lost); messages per Error handling below.

### 3. Frontend API helper (`frontend/src/lib/api/issues.ts`)

```ts
export interface IssueReport {
  type: 'bug' | 'improvement';
  title: string;
  description: string;
}
export interface IssueContext {
  appVersion: string;
  platform: string;
  env: string;
  reporter: string;
}
export function buildIssuePayload(report: IssueReport, context: IssueContext): IssuePayload;
export async function submitIssue(payload: IssuePayload): Promise<{ number: number; html_url: string }>;
```

- `buildIssuePayload` is a pure function (unit-testable): trims/validates fields and
  assembles the final body markdown — description followed by a `---` separator and
  a context table.
- `submitIssue` POSTs to `${getConfigUrl()}/api/v1/issues` (same URL resolution as
  `clientConfig.ts`: dev `localhost:3904`, test `localhost:4904`, prod
  `VITE_PROD_CONFIG_URL`). 15s timeout via `AbortSignal.timeout`.

### 4. Config server endpoint (`matou-infrastructure/config-server.py`)

New `do_POST` branch: `POST /api/v1/issues`.

- **Config (env vars):**
  - `FORGEJO_TOKEN` — bot token; if unset, respond `503 {"success": false,
    "error": "issue_reporting_not_configured"}`.
  - `FORGEJO_URL` — default `https://git.matou.nz`.
  - `FORGEJO_REPO` — default `Matou/matou-app`.
- **Rate limiting:** same pattern as `_check_email_rate_limit()` — separate
  counter, 5 issues per 60s window, `429` on excess.
- **Validation:** `type` ∈ {`bug`, `improvement`}; `title` non-empty ≤ 200 chars;
  `body` non-empty ≤ 20000 chars; `400` otherwise.
- **Label resolution:** on first successful use, `GET
  /api/v1/repos/{repo}/labels` (token auth), match `bug` and `enhancement` by
  case-insensitive name, cache name→id in memory for the process lifetime.
  `type=bug` → `bug` label, `type=improvement` → `enhancement`. If a label is
  missing or the lookup fails, create the issue **without** labels — a label
  problem must never fail a report.
- **Create:** `POST {FORGEJO_URL}/api/v1/repos/{FORGEJO_REPO}/issues` with
  `Authorization: token {FORGEJO_TOKEN}`, JSON `{title, body, labels: [id...]}`.
- **Response:** `200 {"success": true, "number": N, "html_url": "..."}` on
  success; `502 {"success": false, "error": "forgejo_error"}` on Forgejo failure
  (detail printed to config-server log only, not returned to clients).

## Error handling (user-facing copy)

| Condition | Dialog message |
|---|---|
| Network failure / timeout / 503 not-configured | "Couldn't reach the issue service. Check your connection, or email ben@matou.nz." |
| 429 rate limited | "Too many reports right now — please try again in a minute." |
| 400 validation (shouldn't occur; client validates first) | "Something was wrong with the report. Please check the fields and try again." |
| 502 Forgejo error | "The issue couldn't be created. Please try again later or email ben@matou.nz." |

## Testing

- **Vitest** (`frontend/tests/scripts/issue-report.test.ts`): `buildIssuePayload` —
  field trimming, length validation, context block formatting, bug vs improvement.
- **Manual e2e:** run config-server locally with a real `FORGEJO_TOKEN`, submit
  from the dev app, verify the issue lands in Forgejo with the right label and
  context block; verify the 503 path with the token unset.
- No Playwright coverage — the flow terminates at an external service; not worth a
  mock harness for one dialog.

## Rollout order

Everything is verified on local dev infra first; production is touched last.

1. Implement frontend + config-server changes; unit tests pass.
2. Run config-server.py **locally** (dev mode, port 3904) with a `FORGEJO_TOKEN`
   set in its environment, and verify the full flow from the dev app: issue lands
   in Forgejo with label + context block; 503 path with token unset; rate limit.
   Test issues are closed/deleted afterwards.
3. Only after local verification: push the config-server change to production
   (awa.matou.nz) and set the production `FORGEJO_TOKEN` there.

## One-time admin steps (user-owned)

1. Create a bot user on git.matou.nz with access limited to `Matou/matou-app`,
   and generate a token scoped to **issue: read-and-write** only (used for both
   local testing and production).
2. Set `FORGEJO_TOKEN` in the config-server environment on awa.matou.nz and
   restart it (step 3 of rollout, after local verification).
3. Ensure `bug` and `enhancement` labels exist on the repo (defaults usually do).

## Out of scope (YAGNI)

- Screenshots or file attachments
- Automatic log capture/attachment
- Browsing or tracking issue status in-app
- Adding/syncing the Forgejo git remote (API path doesn't need it)
- CAPTCHA / abuse handling beyond rate limiting (revisit if spam appears)
