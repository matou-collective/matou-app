# Triage ask threads + multi-round design conversations — Design

**Date:** 2026-08-06
**Status:** Approved (Ben, in-session)
**Repos:** Matou/ourcloud (canonical harness) and Matou/matou-app

## Problem

When triage routes an issue to `ready-for-human`, the only Mattermost output is
the `:wave: **Triage needs you**` digest — a link, not a question. The actual
question sits as a comment on the Forgejo issue, and nothing ever posts an
answerable `:raising_hand:` thread for it: those come only from `ask-human.sh`,
which runs solely inside an agent iteration. The resume sweep can't help either
— it only *reads* ask threads that already exist. Net effect (observed by Ben):
"all it posted was triage needs you with a link to the issue."

Additionally, every `ask-human.sh` round today opens a **new** thread (a
consumed thread is never reused), so a back-and-forth design conversation
fragments across threads. Ben wants multiple rounds of question/answer to flow
in **one** Mattermost thread per issue, so a feature can be designed there.

## Design

### 1. Per-question thread model (replaces per-thread consumption)

One conversation thread per issue, rooted at the newest bot root post starting
`:raising_hand:` that names `#N` (same channel-scan keying as today). Within a
thread:

- **Question post** = the root, or a bot thread-reply starting `:raising_hand:`.
- **Current question** = the question post with the greatest `create_at`.
- **Answered** = ≥1 human post in the thread with `create_at >=` the current
  question's.
- **Consumed** = a bot `:white_check_mark:` post with `create_at >=` the
  current question's.

Backward compatible: an existing single-round thread (root question → human
reply → checkmark) evaluates identically under these rules. `:eyes:` /
`:hourglass:` bot notes are neither questions nor answers nor consumption.

A thread whose root is older than `ASK_HUMAN_LOOKBACK` (48 h) falls out of
scope; the next question starts a fresh thread. The issue's comments remain the
durable record across threads.

### 2. New shared helper: `post-issue-ask.sh <issue-number>` (manifest-tracked)

Idempotent "make sure this issue has an outstanding question" primitive:

1. Find the newest in-lookback root for `#N`. If its current question is not
   consumed → an ask is already outstanding → exit 0, post nothing.
2. Compose the question: newest comment on the issue (this is where triage —
   and agents — write what needs deciding), blockquoted, capped ~500 chars;
   fallback to the issue body excerpt; plus `[#N title](html_url)` and a note
   that the reply is recorded on the issue and re-arms `ready-for-agent`.
3. If an idle thread exists (current question consumed) → post the question as
   a `:raising_hand:` **thread reply** (multi-round continues in-thread).
   Otherwise post a new `:raising_hand:` **root**.

Generic (no repo-slug references — everything comes from `FORGEJO_API` env and
the issue's own `html_url`), so it joins the `harness-manifest`. Env + secrets
fallback identical to `resume-parked-asks.sh`. Exit 0 posted-or-outstanding,
2 env unset.

### 3. `run-triage.sh` (per-repo, both): ask immediately after triage

For each issue newly at a human gate: if the label is `ready-for-human`, call
`post-issue-ask.sh <n> || true` — the question thread appears straight after
triage. Other gate labels (ourcloud's `needs-design`) keep flowing into the
`:wave:` digest, which is now only posted when it has such entries. matou-app's
gate list is `ready-for-human` only, so its digest naturally never fires; the
`:mag: Verify` flow for `awaiting-verification` is untouched. `needs-design`
lifecycle stays manual (out of scope).

### 4. `ask-human.sh` (canonical in ourcloud, synced): rounds share the thread

- Candidate scan drops the thread-level "any checkmark → skip" filter; each
  candidate thread is judged by its **current question**:
  - answered and not consumed → return that reply now (late-reply recovery);
  - unanswered and not consumed → resume it (`:eyes:`, poll) — the #129
    duplicate-ask protection is preserved;
  - consumed → remember the newest such thread as the *idle* thread.
- If nothing to resume/return and an idle thread exists → post the new
  question as a `:raising_hand:` thread reply on it; else post a new root.
- Polling and reply-pickup filter by `create_at >=` the question's own
  `create_at` (taken from the create-post response), so old rounds' replies are
  never re-read as new answers.

### 5. `resume-parked-asks.sh` (per-repo, both): per-question pickup + ask backstop

- Reply pickup uses the same per-question rules (answered ∧ ¬consumed on the
  *current* question). Ordering unchanged: issue comment → re-arm labels →
  `:white_check_mark:` LAST.
- **Backstop:** after scanning, if the issue was not re-armed, call
  `post-issue-ask.sh <n> || true`. Covers: triage crashed before asking, issue
  parked by hand, an idle thread on a still-parked issue (next round's question
  gets posted from the issue's newest comment). Since the helper no-ops on an
  outstanding question, sweeps never duplicate asks.

### 6. `prompt.md` (matou-app): adopt ourcloud's exit-0 rule

Add to rule 4: on exit 0, comment the question *and* the answer onto the issue
(the durable record) — required for multi-round, since the next question is
composed from the issue's newest comment.

## The multi-round loop, end to end

triage parks `#N` → `run-triage.sh` posts the root ask quoting triage's comment
→ Ben answers in-thread → sweep records the ruling, re-arms `ready-for-agent`,
checkmarks → agent reads the ruling, hits the next decision → `ask-human.sh`
posts round 2 *in the same thread* (live 20-min wait; on timeout the sweep
picks the late answer up) → … repeat until designed. One thread tells the whole
story; the issue's comments hold every Q&A durably.

## Testing (offline fakebin/curl harness, both repos)

- New `tests/post-issue-ask-test.sh`: outstanding question → no post; no thread
  → root posted quoting newest comment; idle thread → follow-up reply posted;
  no comments → body excerpt; stale root (out of lookback) → new root; env
  unset → exit 2.
- `tests/resume-parked-asks-test.sh`: existing cases updated where semantics
  changed (consumed thread on a parked issue now triggers a follow-up ask; a
  parked issue with no thread now gets a root ask instead of being skipped);
  new multi-round case (Q1 ✓-consumed, Q2 follow-up answered → A2 recorded,
  re-armed, checkmark last).
- `tests/test-ask-human.sh`: T4 (consumed → new root) becomes consumed →
  follow-up reply in the same thread; new case proving old-round replies are
  not picked up as the new answer.
- `tests/fakebin/curl`: gains GET single-issue (`issue-<n>.json`), GET comments
  (`comments-<n>.json`), and `create_at` on created posts.

## Sync / deploy order

1. ourcloud (branch off origin/main; working tree has unrelated WIP):
   ask-human.sh, post-issue-ask.sh (+ manifest entry), resume-parked-asks.sh,
   run-triage.sh, tests. Commit; this SHA becomes the new canonical rev.
2. Push ourcloud so the rev is fetchable, merge/ff to main **without squash**
   (the drift check pins the exact SHA).
3. matou-app main: copy the manifest files byte-identical (slug transform is a
   no-op on all of them), per-repo edits (resume-parked-asks.sh, run-triage.sh,
   prompt.md, tests), bump `rev=` in `.sandcastle/.harness-canonical`. Commit,
   push.
4. First sweep after deploy posts one ask per currently-parked issue (bounded
   burst, by design).

## Out of scope

- ourcloud `needs-design` auto-asking / lifecycle.
- matou-app `awaiting-verification` `:mag:` flow (unchanged).
- Multi-message answers: a round's answer is the first human post after the
  question, as today.
