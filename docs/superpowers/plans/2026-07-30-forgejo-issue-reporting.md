# In-app Issue Reporting to Forgejo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Report an issue" button to the dashboard side nav (above the user profile) that opens a dialog and files a bug/improvement issue to `https://git.matou.nz/Matou/matou-app` via a config-server proxy.

**Architecture:** Frontend dialog builds an issue payload (pure, unit-tested) and POSTs it to `{configServerUrl}/api/v1/issues`. The config server (`matou-infrastructure/config-server.py`, Python stdlib HTTP server, runs in docker) holds the `FORGEJO_TOKEN` and creates the issue via Forgejo's REST API. No credentials ship with the app. Local dev infra is used for all verification before production is touched.

**Tech Stack:** Vue 3 `<script setup>` + Quasar (QDialog), lucide-vue-next icons, Vitest, Python 3.11 stdlib (`urllib`), docker compose.

**Spec:** `docs/superpowers/specs/2026-07-30-forgejo-issue-reporting-design.md`

## Global Constraints

- Two repos: Tasks 1–4 in `/home/benz/Documents/1.projects/matou-app` (commit there), Task 5 in `/home/benz/Documents/1.projects/matou-infrastructure` (commit there).
- Field limits: title ≤ 200 chars, description ≤ 5000 chars (client), body ≤ 20000 chars (server). Type ∈ {`bug`, `improvement`}.
- Issue-type → Forgejo label mapping: `bug` → `bug`, `improvement` → `enhancement`. A label failure must NEVER fail issue creation.
- Rate limit on config server: 5 issues per 60 s window, HTTP 429.
- User-facing error copy (exact strings, used in Task 3):
  - unreachable/503: `Couldn't reach the issue service. Check your connection, or email ben@matou.nz.`
  - 429: `Too many reports right now — please try again in a minute.`
  - 400: `Something was wrong with the report. Please check the fields and try again.`
  - other/502: `The issue couldn't be created. Please try again later or email ben@matou.nz.`
- Production (awa.matou.nz, production `FORGEJO_TOKEN`) is touched ONLY in Task 7, after local verification in Task 6.
- Frontend commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure issue-payload builder (`issueReport.ts`) — TDD

**Files:**
- Create: `frontend/src/lib/issueReport.ts`
- Test: `frontend/tests/scripts/issue-report.test.ts`

**Interfaces:**
- Consumes: nothing (zero imports — keep it pure so Vitest never drags in app modules).
- Produces (used by Tasks 2–3):
  - `type IssueType = 'bug' | 'improvement'`
  - `TITLE_MAX = 200`, `DESCRIPTION_MAX = 5000` (exported consts)
  - `interface IssueReport { type: IssueType; title: string; description: string }`
  - `interface IssueContext { appVersion: string; platform: string; env: string; reporter: string }`
  - `interface IssuePayload { type: IssueType; title: string; body: string }`
  - `buildIssuePayload(report: IssueReport, context: IssueContext): IssuePayload` — throws `Error` on invalid input
  - `summarizePlatform(userAgent: string): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/scripts/issue-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildIssuePayload,
  summarizePlatform,
  TITLE_MAX,
  DESCRIPTION_MAX,
} from '../../src/lib/issueReport';

const CONTEXT = {
  appVersion: '0.3.0',
  platform: 'Electron on X11; Linux x86_64',
  env: 'dev',
  reporter: 'Ben',
};

describe('buildIssuePayload', () => {
  it('trims fields and appends a context table after a separator', () => {
    const p = buildIssuePayload(
      { type: 'bug', title: '  Crash on login  ', description: '  It crashed.  ' },
      CONTEXT,
    );
    expect(p.type).toBe('bug');
    expect(p.title).toBe('Crash on login');
    expect(p.body).toContain('It crashed.');
    expect(p.body).toContain('| App version | 0.3.0 |');
    expect(p.body).toContain('| Platform | Electron on X11; Linux x86_64 |');
    expect(p.body).toContain('| Environment | dev |');
    expect(p.body).toContain('| Reporter | Ben |');
    expect(p.body.indexOf('It crashed.')).toBeLessThan(p.body.indexOf('---'));
  });

  it('accepts the improvement type', () => {
    const p = buildIssuePayload(
      { type: 'improvement', title: 'Dark mode', description: 'Please add it.' },
      CONTEXT,
    );
    expect(p.type).toBe('improvement');
  });

  it('rejects empty or whitespace-only title and description', () => {
    expect(() =>
      buildIssuePayload({ type: 'bug', title: '   ', description: 'x' }, CONTEXT),
    ).toThrow(/title/i);
    expect(() =>
      buildIssuePayload({ type: 'bug', title: 'x', description: '  ' }, CONTEXT),
    ).toThrow(/description/i);
  });

  it('rejects over-length fields', () => {
    expect(() =>
      buildIssuePayload(
        { type: 'bug', title: 'a'.repeat(TITLE_MAX + 1), description: 'x' },
        CONTEXT,
      ),
    ).toThrow(/title/i);
    expect(() =>
      buildIssuePayload(
        { type: 'bug', title: 'x', description: 'a'.repeat(DESCRIPTION_MAX + 1) },
        CONTEXT,
      ),
    ).toThrow(/description/i);
  });

  it('rejects unknown types', () => {
    expect(() =>
      buildIssuePayload(
        { type: 'feature' as never, title: 'x', description: 'y' },
        CONTEXT,
      ),
    ).toThrow(/type/i);
  });
});

describe('summarizePlatform', () => {
  it('detects Electron and extracts the OS parenthetical', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/28.1.0 Safari/537.36';
    expect(summarizePlatform(ua)).toBe('Electron on X11; Linux x86_64');
  });

  it('labels non-Electron agents as Web', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    expect(summarizePlatform(ua)).toBe('Web on Macintosh; Intel Mac OS X 10_15_7');
  });

  it('falls back to unknown for empty/odd agents', () => {
    expect(summarizePlatform('')).toBe('Web on unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx vitest run tests/scripts/issue-report.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/issueReport`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/issueReport.ts`:

```ts
/**
 * Pure helpers for the in-app "Report an issue" flow.
 * No imports — kept pure so unit tests never drag in app modules.
 * Network submission lives in src/lib/api/issues.ts.
 */

export type IssueType = 'bug' | 'improvement';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;

export interface IssueReport {
  type: IssueType;
  title: string;
  description: string;
}

export interface IssueContext {
  appVersion: string;
  platform: string;
  env: string;
  reporter: string;
}

export interface IssuePayload {
  type: IssueType;
  title: string;
  body: string;
}

/**
 * Validate a report and assemble the final issue payload. The body is the
 * user's description followed by a context table so stewards can triage
 * without asking "what version are you on?".
 */
export function buildIssuePayload(report: IssueReport, context: IssueContext): IssuePayload {
  if (report.type !== 'bug' && report.type !== 'improvement') {
    throw new Error('Unknown issue type');
  }
  const title = report.title.trim();
  const description = report.description.trim();
  if (!title) throw new Error('Title is required');
  if (title.length > TITLE_MAX) {
    throw new Error(`Title must be ${TITLE_MAX} characters or fewer`);
  }
  if (!description) throw new Error('Description is required');
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`Description must be ${DESCRIPTION_MAX} characters or fewer`);
  }

  const body = [
    description,
    '',
    '---',
    '',
    '| Context | |',
    '| --- | --- |',
    `| App version | ${context.appVersion} |`,
    `| Platform | ${context.platform} |`,
    `| Environment | ${context.env} |`,
    `| Reporter | ${context.reporter} |`,
  ].join('\n');

  return { type: report.type, title, body };
}

/** "Electron on X11; Linux x86_64" — short enough for a table cell. */
export function summarizePlatform(userAgent: string): string {
  const kind = userAgent.includes('Electron') ? 'Electron' : 'Web';
  const os = /\(([^)]+)\)/.exec(userAgent)?.[1] ?? 'unknown';
  return `${kind} on ${os}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx vitest run tests/scripts/issue-report.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/issueReport.ts frontend/tests/scripts/issue-report.test.ts
git commit -m "feat(issues): pure payload builder for in-app issue reports

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Submission client (`api/issues.ts`)

**Files:**
- Create: `frontend/src/lib/api/issues.ts`

**Interfaces:**
- Consumes: `buildIssuePayload`, `summarizePlatform`, types from `src/lib/issueReport` (Task 1); `getConfigUrl()`, `getEnv()` from `src/lib/clientConfig` (existing); `version` from `package.json` (existing pattern, see `src/components/onboarding/SplashScreen.vue:108`).
- Produces (used by Task 3):
  - `collectIssueContext(reporterName: string): IssueContext`
  - `interface IssueResult { number: number; html_url: string }`
  - `type IssueErrorCode = 'unreachable' | 'rate_limited' | 'invalid' | 'server'`
  - `class IssueSubmitError extends Error { code: IssueErrorCode }`
  - `submitIssue(payload: IssuePayload): Promise<IssueResult>` — throws `IssueSubmitError`

No unit test: this module is thin network glue over the tested builder; it is exercised end-to-end in Task 6.

- [ ] **Step 1: Write the implementation**

Create `frontend/src/lib/api/issues.ts`:

```ts
/**
 * Issue reporting client. POSTs to the config server's Forgejo proxy —
 * the Forgejo token lives only on the config server, never in the app.
 */

import { version as appVersion } from '../../../package.json';
import { getConfigUrl, getEnv } from '../clientConfig';
import { summarizePlatform, type IssueContext, type IssuePayload } from '../issueReport';

export interface IssueResult {
  number: number;
  html_url: string;
}

export type IssueErrorCode = 'unreachable' | 'rate_limited' | 'invalid' | 'server';

export class IssueSubmitError extends Error {
  constructor(
    public code: IssueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IssueSubmitError';
  }
}

export function collectIssueContext(reporterName: string): IssueContext {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return {
    appVersion,
    platform: summarizePlatform(ua),
    env: getEnv(),
    reporter: reporterName.trim() || 'Anonymous',
  };
}

export async function submitIssue(payload: IssuePayload): Promise<IssueResult> {
  let res: Response;
  try {
    res = await fetch(`${getConfigUrl()}/api/v1/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new IssueSubmitError('unreachable', `Config server unreachable: ${String(err)}`);
  }

  if (res.status === 503) {
    throw new IssueSubmitError('unreachable', 'Issue reporting not configured on server');
  }
  if (res.status === 429) {
    throw new IssueSubmitError('rate_limited', 'Rate limit exceeded');
  }
  if (res.status === 400) {
    throw new IssueSubmitError('invalid', 'Server rejected the report payload');
  }
  if (!res.ok) {
    throw new IssueSubmitError('server', `Issue creation failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    success: boolean;
    number?: number;
    html_url?: string;
  };
  if (!data.success || typeof data.number !== 'number') {
    throw new IssueSubmitError('server', 'Issue creation failed');
  }
  return { number: data.number, html_url: data.html_url ?? '' };
}
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "issues.ts"; npm run lint -- --no-fix 2>&1 | grep -iA2 "issues.ts"`
Expected: no output from either grep (no errors in the new file). If `vue-tsc` isn't available, `npm run lint` alone is sufficient.

- [ ] **Step 3: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/api/issues.ts
git commit -m "feat(issues): config-server submission client for issue reports

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `ReportIssueDialog.vue`

**Files:**
- Create: `frontend/src/components/common/ReportIssueDialog.vue`

**Interfaces:**
- Consumes: Task 1 (`buildIssuePayload`, `TITLE_MAX`, `DESCRIPTION_MAX`, `IssueType`), Task 2 (`collectIssueContext`, `submitIssue`, `IssueSubmitError`, `IssueResult`).
- Produces (used by Task 4): component with props `{ modelValue: boolean; reporterName: string }`, emits `update:modelValue`. Follows the codebase dialog convention (`ConfirmArchiveDialog.vue`): `q-dialog` + `q-card` + `.dialog-footer` buttons.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/common/ReportIssueDialog.vue`:

```vue
<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="onDialogToggle"
  >
    <q-card class="report-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="bug_report" color="primary" size="24px" />
        <div class="text-h6 q-ml-sm">Report an issue</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <!-- Success state -->
      <template v-if="result">
        <q-card-section>
          <p class="success-text">Thanks — logged as issue #{{ result.number }}.</p>
          <p v-if="result.html_url" class="issue-url">{{ result.html_url }}</p>
        </q-card-section>
        <div class="dialog-footer">
          <q-btn
            outline
            no-caps
            color="primary"
            label="Close"
            class="dialog-footer-btn"
            v-close-popup
          />
        </div>
      </template>

      <!-- Form state -->
      <template v-else>
        <q-card-section>
          <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>

          <q-btn-toggle
            v-model="type"
            :options="[
              { label: 'Bug', value: 'bug' },
              { label: 'Improvement', value: 'improvement' },
            ]"
            no-caps
            unelevated
            toggle-color="primary"
            class="q-mb-md"
          />

          <q-input
            v-model="title"
            label="Title"
            outlined
            dense
            :maxlength="TITLE_MAX"
            class="q-mb-md"
          />

          <q-input
            v-model="description"
            type="textarea"
            label="Description"
            outlined
            rows="5"
            :maxlength="DESCRIPTION_MAX"
            :placeholder="
              type === 'bug'
                ? 'What happened? What did you expect to happen?'
                : 'What would you like to see?'
            "
          />

          <div class="context-preview">
            <div class="context-preview-title">Included with your report</div>
            <div>App version {{ context.appVersion }} · {{ context.env }}</div>
            <div>{{ context.platform }}</div>
            <div>Reported by {{ context.reporter }}</div>
          </div>
        </q-card-section>

        <div class="dialog-footer">
          <q-btn
            color="primary"
            no-caps
            unelevated
            label="Submit"
            class="dialog-footer-btn"
            :loading="submitting"
            :disable="!canSubmit"
            @click="onSubmit"
          />
          <q-btn
            outline
            no-caps
            color="primary"
            label="Cancel"
            class="dialog-footer-btn"
            v-close-popup
          />
        </div>
      </template>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  buildIssuePayload,
  DESCRIPTION_MAX,
  TITLE_MAX,
  type IssueType,
} from 'src/lib/issueReport';
import {
  collectIssueContext,
  IssueSubmitError,
  submitIssue,
  type IssueResult,
} from 'src/lib/api/issues';

const props = defineProps<{
  modelValue: boolean;
  reporterName: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const type = ref<IssueType>('bug');
const title = ref('');
const description = ref('');
const submitting = ref(false);
const errorMessage = ref('');
const result = ref<IssueResult | null>(null);

const context = computed(() => collectIssueContext(props.reporterName));

const canSubmit = computed(
  () => title.value.trim().length > 0 && description.value.trim().length > 0 && !submitting.value,
);

// Fresh form each time the dialog is opened.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      type.value = 'bug';
      title.value = '';
      description.value = '';
      errorMessage.value = '';
      result.value = null;
      submitting.value = false;
    }
  },
);

function onDialogToggle(value: boolean) {
  emit('update:modelValue', value);
}

const ERROR_COPY: Record<string, string> = {
  unreachable: "Couldn't reach the issue service. Check your connection, or email ben@matou.nz.",
  rate_limited: 'Too many reports right now — please try again in a minute.',
  invalid: 'Something was wrong with the report. Please check the fields and try again.',
  server: "The issue couldn't be created. Please try again later or email ben@matou.nz.",
};

async function onSubmit() {
  errorMessage.value = '';
  submitting.value = true;
  try {
    const payload = buildIssuePayload(
      { type: type.value, title: title.value, description: description.value },
      context.value,
    );
    result.value = await submitIssue(payload);
  } catch (err) {
    errorMessage.value =
      err instanceof IssueSubmitError
        ? ERROR_COPY[err.code]
        : ERROR_COPY.server;
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped lang="scss">
.report-dialog {
  min-width: 420px;
  max-width: 520px;
}

.error-banner {
  background: rgba(220, 53, 69, 0.08);
  color: var(--matou-destructive, #dc3545);
  border: 1px solid rgba(220, 53, 69, 0.3);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.context-preview {
  margin-top: 1rem;
  padding: 0.625rem 0.75rem;
  border: 1px dashed var(--matou-border, #ddd);
  border-radius: 8px;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #6b7280);

  .context-preview-title {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
}

.success-text {
  font-size: 0.9375rem;
}

.issue-url {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #6b7280);
  word-break: break-all;
}

.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--matou-border);
}

.dialog-footer-btn {
  flex: 1;
}
</style>
```

- [ ] **Step 2: Lint**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run lint -- --no-fix 2>&1 | grep -iB1 -A3 "ReportIssueDialog"`
Expected: no output (no errors for the new component).

- [ ] **Step 3: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/components/common/ReportIssueDialog.vue
git commit -m "feat(issues): report-issue dialog component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Side nav button in `DashboardLayout.vue`

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.vue` (template `.sidebar-footer` ~line 60; script imports ~lines 91–117; styles — `.sidebar-footer` rule)

**Interfaces:**
- Consumes: `ReportIssueDialog` (Task 3), existing `userName` computed (`DashboardLayout.vue:208`), `Bug` icon from `lucide-vue-next`.
- Produces: the user-visible entry point. No new exports.

- [ ] **Step 1: Add the button and dialog to the template**

In the template, replace the `.sidebar-footer` block:

```html
      <!-- User Profile -->
      <div class="sidebar-footer">
        <div class="user-profile" @click="router.push({ name: 'account-settings' })" style="cursor: pointer;">
```

with:

```html
      <!-- Footer: report issue + user profile -->
      <div class="sidebar-footer">
        <button class="nav-item report-issue-btn" @click="showReportDialog = true">
          <Bug class="nav-icon" />
          <span>Report an issue</span>
        </button>
        <div class="user-profile" @click="router.push({ name: 'account-settings' })" style="cursor: pointer;">
```

Then, next to the existing `<ProfileModal .../>` near the end of the template, add:

```html
    <ReportIssueDialog v-model="showReportDialog" :reporter-name="userName" />
```

- [ ] **Step 2: Wire up the script**

In the lucide import block (`DashboardLayout.vue:92-100`), add `Bug` to the named imports. In the vue import (`line 91`), add `ref`:

```ts
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
```

Next to the `ProfileModal` import (`line 116`), add:

```ts
import ReportIssueDialog from 'src/components/common/ReportIssueDialog.vue';
```

After the store setup (around `line 130`, near `const profileViewer = ...`), add:

```ts
const showReportDialog = ref(false);
```

- [ ] **Step 3: Style the button**

In the `<style>` section, after the `.sidebar-footer` rule, add:

```scss
.report-issue-btn {
  font-size: 0.85rem;
  color: var(--matou-sidebar-foreground);
  opacity: 0.75;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;

  &:hover {
    opacity: 1;
  }

  .nav-icon {
    width: 16px;
    height: 16px;
  }
}
```

- [ ] **Step 4: Lint and visually verify**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run lint -- --no-fix 2>&1 | grep -iB1 -A3 "DashboardLayout"`
Expected: no output.

If the dev server is running (`npm run dev`), open the app: the "Report an issue" button appears in the sidebar footer above the profile row; clicking opens the dialog; Cancel closes it. (Submission will fail with the "Couldn't reach…" banner until Task 5 — expected.)

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/layouts/DashboardLayout.vue
git commit -m "feat(issues): report-issue button in dashboard side nav

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Config-server Forgejo proxy (`matou-infrastructure` repo)

**Files:**
- Modify: `/home/benz/Documents/1.projects/matou-infrastructure/config-server.py` (module-level config after the email rate-limiter ~line 80; new `do_POST` branch before the final `else` ~line 342)
- Modify: `/home/benz/Documents/1.projects/matou-infrastructure/keri/docker-compose.yml` (config-server `environment:` block, after `RESEND_API_KEY`)
- Modify: `/home/benz/Documents/1.projects/matou-infrastructure/keri/docker-compose.prod.yml` (same env addition to its config-server service, if that service defines `environment:` — mirror the dev change)

**Interfaces:**
- Consumes: HTTP POST `/api/v1/issues` with JSON `{type, title, body}` (what Task 2's `submitIssue` sends).
- Produces: `200 {"success": true, "number": N, "html_url": "..."}`; `503 issue_reporting_not_configured`; `429 rate_limit_exceeded`; `400 invalid_*`; `502 forgejo_error`. Env vars: `FORGEJO_TOKEN` (required to enable), `FORGEJO_URL` (default `https://git.matou.nz`), `FORGEJO_REPO` (default `Matou/matou-app`).

- [ ] **Step 1: Add module-level config and helpers**

In `config-server.py`, after the `_check_email_rate_limit` function (~line 88), add:

```python
# Forgejo issue-reporting proxy (in-app bug/improvement reports).
# The token lives ONLY here — never shipped with the app.
FORGEJO_TOKEN = os.environ.get("FORGEJO_TOKEN", "")
FORGEJO_URL = os.environ.get("FORGEJO_URL", "https://git.matou.nz")
FORGEJO_REPO = os.environ.get("FORGEJO_REPO", "Matou/matou-app")

ISSUE_RATE_LIMIT = 5  # max issues per window
ISSUE_RATE_WINDOW = 60  # seconds
_issue_timestamps: list[float] = []

ISSUE_TYPE_LABELS = {"bug": "bug", "improvement": "enhancement"}
ISSUE_TITLE_MAX = 200
ISSUE_BODY_MAX = 20000

# name -> id, populated on first use; process-lifetime cache
_forgejo_label_cache: dict[str, int] | None = None


def _check_issue_rate_limit() -> bool:
    """Return True if under rate limit, False if exceeded."""
    now = time.time()
    while _issue_timestamps and _issue_timestamps[0] < now - ISSUE_RATE_WINDOW:
        _issue_timestamps.pop(0)
    if len(_issue_timestamps) >= ISSUE_RATE_LIMIT:
        return False
    _issue_timestamps.append(now)
    return True


def _forgejo_request(method: str, path: str, payload: dict | None = None):
    """Call the Forgejo REST API with the bot token."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(
        f"{FORGEJO_URL}/api/v1{path}",
        data=data,
        headers={
            "Authorization": f"token {FORGEJO_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "matou-config-server/1.0",
        },
        method=method,
    )
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _forgejo_label_id(issue_type: str) -> int | None:
    """Resolve issue type to a repo label id. Never raises — a label
    problem must not fail issue creation."""
    global _forgejo_label_cache
    try:
        if _forgejo_label_cache is None:
            labels = _forgejo_request("GET", f"/repos/{FORGEJO_REPO}/labels")
            _forgejo_label_cache = {l["name"].lower(): l["id"] for l in labels}
        return _forgejo_label_cache.get(ISSUE_TYPE_LABELS[issue_type])
    except Exception as e:
        print(f"[Config Server] Forgejo label lookup failed (continuing without label): {e}")
        return None
```

- [ ] **Step 2: Add the POST branch**

In `do_POST`, insert a new branch between the `elif path == "/api/send-email":` block and the final `else:`:

```python
        elif path == "/api/v1/issues":
            if not FORGEJO_TOKEN:
                self._send_json({"success": False, "error": "issue_reporting_not_configured"}, 503)
                return
            if not _check_issue_rate_limit():
                self._send_json({"success": False, "error": "rate_limit_exceeded"}, 429)
                return

            try:
                data = json.loads(self._read_body())
            except json.JSONDecodeError as e:
                self._send_json({"success": False, "error": f"invalid_json: {e}"}, 400)
                return

            issue_type = data.get("type", "")
            title = (data.get("title") or "").strip()
            body = (data.get("body") or "").strip()

            if issue_type not in ISSUE_TYPE_LABELS:
                self._send_json({"success": False, "error": "invalid_type"}, 400)
                return
            if not title or len(title) > ISSUE_TITLE_MAX:
                self._send_json({"success": False, "error": "invalid_title"}, 400)
                return
            if not body or len(body) > ISSUE_BODY_MAX:
                self._send_json({"success": False, "error": "invalid_body"}, 400)
                return

            label_id = _forgejo_label_id(issue_type)
            payload = {"title": title, "body": body}
            if label_id is not None:
                payload["labels"] = [label_id]

            try:
                issue = _forgejo_request("POST", f"/repos/{FORGEJO_REPO}/issues", payload)
                print(f"[Config Server] Forgejo issue #{issue.get('number')} created ({issue_type})")
                self._send_json({
                    "success": True,
                    "number": issue.get("number"),
                    "html_url": issue.get("html_url"),
                })
            except Exception as e:
                # Detail stays in the server log; clients get a generic error.
                print(f"[Config Server] Forgejo issue creation failed: {e}")
                self._send_json({"success": False, "error": "forgejo_error"}, 502)
```

- [ ] **Step 3: Pass env through docker compose**

In `keri/docker-compose.yml`, in the `config-server` service `environment:` block, after the `RESEND_API_KEY` line, add:

```yaml
      # Forgejo issue-reporting proxy (in-app bug reports)
      FORGEJO_TOKEN: ${FORGEJO_TOKEN:-}
      FORGEJO_URL: ${FORGEJO_URL:-https://git.matou.nz}
      FORGEJO_REPO: ${FORGEJO_REPO:-Matou/matou-app}
```

Check `keri/docker-compose.prod.yml`: if it defines the config-server service with its own `environment:` block, add the same three lines there.

- [ ] **Step 4: Syntax-check and restart the dev config server**

```bash
cd /home/benz/Documents/1.projects/matou-infrastructure
python3 -m py_compile config-server.py && echo OK
cd keri && docker compose up -d config-server
```

Expected: `OK`, then the container recreates/restarts cleanly (`docker ps` shows `matou-keri-config-server-1` healthy).

- [ ] **Step 5: Verify the unconfigured and validation paths with curl**

No `FORGEJO_TOKEN` is exported yet, so:

```bash
# 503 when token absent
curl -s -X POST http://localhost:3904/api/v1/issues \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"t","body":"b"}'
```

Expected: `{"success": false, "error": "issue_reporting_not_configured"}` (HTTP 503).

Also confirm existing routes still work: `curl -s http://localhost:3904/api/health` → healthy response.

- [ ] **Step 6: Commit (infrastructure repo)**

```bash
cd /home/benz/Documents/1.projects/matou-infrastructure
git add config-server.py keri/docker-compose.yml keri/docker-compose.prod.yml
git commit -m "feat(config-server): Forgejo issue proxy endpoint for in-app bug reports"
```

(Adjust the `git add` list if `docker-compose.prod.yml` needed no change.)

---

### Task 6: Local end-to-end verification (needs user's Forgejo token)

**Files:** none (verification only).

**BLOCKER — user input required:** a Forgejo bot token. Ask the user to create, on git.matou.nz, a bot user with access limited to `Matou/matou-app` and a token scoped to **issue: read-and-write**, then provide it (or export it themselves). Do not proceed to Task 7 until this task passes.

- [ ] **Step 1: Restart local config server with the token**

```bash
cd /home/benz/Documents/1.projects/matou-infrastructure/keri
export FORGEJO_TOKEN=<token from user>
docker compose up -d config-server
```

- [ ] **Step 2: Validation-error path (bad type)**

```bash
curl -s -X POST http://localhost:3904/api/v1/issues \
  -H 'Content-Type: application/json' \
  -d '{"type":"feature","title":"t","body":"b"}'
```

Expected: `{"success": false, "error": "invalid_type"}` (HTTP 400).

- [ ] **Step 3: Real issue creation via curl**

```bash
curl -s -X POST http://localhost:3904/api/v1/issues \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"[TEST] e2e verification — please ignore","body":"Test issue from local dev verification. Will be closed immediately."}'
```

Expected: `{"success": true, "number": N, "html_url": "https://git.matou.nz/Matou/matou-app/issues/N"}`, and the issue is visible in Forgejo with the `bug` label.

- [ ] **Step 4: Rate-limit path**

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3904/api/v1/issues \
    -H 'Content-Type: application/json' \
    -d '{"type":"feature","title":"t","body":"b"}'
done
```

Expected: `400`s until the 5-per-60s window fills, then `429`s. The exact split depends on how many requests Steps 2–3 made in the previous 60 seconds (if run back-to-back: three `400`s then three `429`s). Invalid payloads consume rate-limit slots — acceptable; they never reach Forgejo. Wait 60s afterwards before Step 5.

- [ ] **Step 5: Full flow from the app**

With the dev app running (`cd frontend && npm run dev`): click **Report an issue** → type Improvement → title "[TEST] dialog e2e — please ignore" → description → Submit. Expected: success state "Thanks — logged as issue #N", issue appears in Forgejo with the `enhancement` label and the context table (app version 0.3.0, platform, env `dev`, reporter name).

- [ ] **Step 6: Cleanup**

Ask the user to close (or delete) the `[TEST]` issues in Forgejo, or close them via API:

```bash
curl -s -X PATCH "https://git.matou.nz/api/v1/repos/Matou/matou-app/issues/<N>" \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":"closed"}'
```

---

### Task 7: Production rollout (user-owned — checklist only)

Only after Task 6 fully passes. These steps run on awa.matou.nz and are for the user (or done together with them):

- [ ] Pull/deploy the updated `matou-infrastructure` (config-server.py + compose files) on awa.matou.nz.
- [ ] Set `FORGEJO_TOKEN` in the production config-server environment (compose `.env` or however production env is managed there) and recreate the config-server container.
- [ ] Verify from a production build of the app (or curl against the production config server): 503 gone, issue creation works.
- [ ] Confirm `bug` and `enhancement` labels exist on `Matou/matou-app`.
- [ ] Close any production test issues.
