# Triage Ask Threads + Multi-Round Design Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `ready-for-human` issue gets an answerable `:raising_hand:` Mattermost question thread straight after triage in BOTH repos, and successive question/answer rounds for an issue continue in that ONE thread, so a feature can be designed via chat.

**Architecture:** A new manifest-tracked helper `post-issue-ask.sh` is the idempotent "ensure this issue has an outstanding question" primitive, called from `run-triage.sh` (immediate) and `resume-parked-asks.sh` (backstop). The thread-consumption model changes from per-thread to per-question: the *current question* is the newest bot `:raising_hand:` post in a thread, consumed only by a `:white_check_mark:` at/after it. `ask-human.sh` posts follow-up questions into the existing (idle) thread instead of new roots.

**Tech Stack:** bash + jq + curl (Mattermost v4 API, Forgejo API); offline test harness at `.sandcastle/tests/` with `fakebin/curl`.

**Spec:** `docs/superpowers/specs/2026-08-06-triage-ask-threads-design.md`

## Global Constraints

- ourcloud is the CANONICAL harness repo; `ask-human.sh` and the new `post-issue-ask.sh` are manifest files — edit them in ourcloud, copy byte-identical to matou-app (the slug transform must be a no-op: NO repo-slug strings in either file).
- ourcloud's working tree has unrelated WIP on branch `private-standup-polish` — all ourcloud work happens in a git worktree branched from `origin/main` (commit 6075dbb). Never touch the main checkout's dirty files.
- matou-app works directly on `main` (clean).
- The matou-app drift check pins the exact ourcloud SHA in `.sandcastle/.harness-canonical` — bump `rev=` in the same matou commit that copies the files; the ourcloud commit must reach git.matou.nz unchanged (ff/merge, never squash).
- Timestamp comparisons are `>=` (test fixtures give several posts the same `create_at`).
- `:eyes:` / `:hourglass:` bot notes are neither questions, answers, nor consumption.
- Message markers are load-bearing contracts: questions start `:raising_hand:`, consumption is a bot post starting `:white_check_mark:`, roots are found by `root_id == ""` + `#N` in the text.
- Matou-app's `awaiting-verification` / `:mag:` flow is untouched. ourcloud's `needs-design` stays in the `:wave:` digest (no auto-ask).

---

### Task 0: Baseline + ourcloud worktree

**Files:** none (setup)

- [ ] **Step 1: Create the ourcloud worktree**

```bash
cd /home/benz/Documents/1.projects/ourcloud
git worktree add -b harness/triage-ask-threads /tmp/claude-1000/-home-benz-Documents-1-projects-matou-app/55ab13fc-f55e-445e-8d2d-62615c6b81b9/scratchpad/ourcloud-harness origin/main
```

(If `origin/main` is unfetchable offline, use local ref `6075dbb`.) Call the worktree `$OC` below.

- [ ] **Step 2: Record baseline test results in BOTH repos**

```bash
cd $OC && for t in .sandcastle/tests/test-ask-human.sh .sandcastle/tests/resume-parked-asks-test.sh .sandcastle/tests/notify-test.sh; do echo "== $t"; bash "$t"; done
cd /home/benz/Documents/1.projects/matou-app && for t in .sandcastle/tests/test-ask-human.sh .sandcastle/tests/resume-parked-asks-test.sh .sandcastle/tests/check-verifications-test.sh .sandcastle/tests/notify-test.sh; do echo "== $t"; bash "$t"; done
```

Expected: all pass (note any pre-existing failures — they are not ours to fix).

---

### Task 1: Fake curl upgrades (ourcloud worktree)

**Files:**
- Modify: `$OC/.sandcastle/tests/fakebin/curl`

**Interfaces:**
- Produces: GET `…/issues/<n>` → `$FAKE_DIR/issue-<n>.json`; GET `…/issues/<n>/comments` → `$FAKE_DIR/comments-<n>.json` (default `[]`); created posts return `{"id":"NEWQ<n>","create_at":<real ms>}`.

- [ ] **Step 1: Apply the three changes**

Replace the `*/api/v4/posts)` case body's echo line:

```bash
    echo "{\"id\":\"NEWQ$n\",\"create_at\":$(date +%s%3N)}"
```

Replace the `*/issues/*/comments)` case with method-aware routing:

```bash
  */issues/*/comments)
    if [ "$method" = GET ]; then
      id="${url%/comments}"; id="${id##*/}"
      cat "$FAKE_DIR/comments-$id.json" 2>/dev/null || echo '[]'
    else
      printf '%s\n' "$body" >>"$FAKE_DIR/forgejo.log"
      echo '{}'
    fi
    ;;
```

Add/replace a method-aware single-issue case (must sit AFTER the two `labels` cases and BEFORE `*/issues\?*`; ourcloud's fake curl lacks this case entirely today, matou-app's has a write-only version):

```bash
  */issues/[0-9]*)
    id="${url##*/}"
    if [ "$method" = GET ]; then
      cat "$FAKE_DIR/issue-$id.json" 2>/dev/null || echo '{}'
    else
      # Single-issue write, e.g. PATCH .../issues/9 {"state":"closed"}.
      printf '%s\n' "$body" >>"$FAKE_DIR/forgejo.log"
      echo '{}'
    fi
    ;;
```

- [ ] **Step 2: Re-run the baseline ourcloud tests**

```bash
cd $OC && bash .sandcastle/tests/test-ask-human.sh && bash .sandcastle/tests/resume-parked-asks-test.sh
```

Expected: still green (`create_at` on created posts is ignored by the current scripts; the GET cases are new routes).

- [ ] **Step 3: Commit**

```bash
cd $OC && git add .sandcastle/tests/fakebin/curl && git commit -m "sandcastle tests: fake curl learns issue/comment GETs and stamps create_at on posts"
```

---

### Task 2: `post-issue-ask.sh` + its test (ourcloud worktree)

**Files:**
- Create: `$OC/.sandcastle/post-issue-ask.sh`
- Create: `$OC/.sandcastle/tests/post-issue-ask-test.sh`
- Modify: `$OC/.sandcastle/harness-manifest`

**Interfaces:**
- Produces: `post-issue-ask.sh <issue-number>` — exit 0 posted-or-outstanding, exit 2 env unset. Posts a root `:raising_hand:` ask (no thread in lookback) or a `:raising_hand:` follow-up reply (idle thread), quoting the issue's newest comment (fallback: body), capped 500 chars. No-ops while a question is outstanding (current question lacks a `:white_check_mark:` at/after it — answered-but-unconsumed also counts as outstanding).

- [ ] **Step 1: Write the failing test**

Create `$OC/.sandcastle/tests/post-issue-ask-test.sh`:

```bash
#!/usr/bin/env bash
# Scenario tests for ../post-issue-ask.sh against the fake Mattermost +
# Forgejo API (fakebin/curl). No network.
#
# Usage: .sandcastle/tests/post-issue-ask-test.sh [path-to-script]
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../post-issue-ask.sh}"
export PATH="$here/fakebin:$PATH"
export MATTERMOST_URL="http://mm.test"
export MATTERMOST_BOT_TOKEN="tok"
export MATTERMOST_CHANNEL_ID="chan"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/ourcloud"

now_ms="$(($(date +%s) * 1000))"
pass=0 fail=0

mkpost() { # mkpost <id> <root> <user> <msg> [create_at_ms]
  jq -n --arg id "$1" --arg root "$2" --arg user "$3" --arg msg "$4" \
    --argjson t "${5:-$now_ms}" \
    '{id:$id, root_id:$root, user_id:$user, message:$msg, create_at:$t, delete_at:0}'
}

mkissue() { # mkissue <number> <body> — writes issue-<n>.json
  jq -n --argjson n "$1" --arg body "$2" \
    '{number:$n, title:"widget frobnicator", html_url:("http://x/"+($n|tostring)), body:$body}' \
    >"$FAKE_DIR/issue-$1.json"
}

ask_msg() { # ask_msg <number> — a plausible existing root ask
  printf ':raising_hand: **Human decision needed** — reply **in this thread** to answer.
[#%s widget frobnicator](http://x/%s)' "$1" "$1"
}

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
  echo '{"posts":{}}' >"$FAKE_DIR/channel.json"
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

# ---- P1: no thread at all — post a fresh root quoting the newest comment
setup
mkissue 301 "issue body text"
jq -n '[{body:"triage: first note"},{body:"What colour should the bikeshed be?"}]' >"$FAKE_DIR/comments-301.json"
bash "$script" 301 >/dev/null 2>&1
rc=$?
check "P1 exit 0" "[ $rc -eq 0 ]"
check "P1 root ask posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""
check "P1 quotes newest comment" "grep -q 'colour should the bikeshed' \"\$FAKE_DIR/posts.log\""
check "P1 links the issue" "grep -q '#301 widget frobnicator' \"\$FAKE_DIR/posts.log\""

# ---- P2: outstanding unanswered question — no post
setup
jq -n --argjson q "$(mkpost Q302 "" BOTID "$(ask_msg 302)")" '{posts:{Q302:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q302 "" BOTID "$(ask_msg 302)")" '{posts:{Q302:$q}}' >"$FAKE_DIR/thread-Q302.json"
bash "$script" 302 >/dev/null 2>&1
rc=$?
check "P2 exit 0" "[ $rc -eq 0 ]"
check "P2 nothing posted" "[ ! -s \"\$FAKE_DIR/posts.log\" ]"

# ---- P3: answered but unconsumed — still outstanding (the sweep's pickup half owns it)
setup
jq -n --argjson q "$(mkpost Q303 "" BOTID "$(ask_msg 303)")" '{posts:{Q303:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q303 "" BOTID "$(ask_msg 303)")" \
  --argjson r "$(mkpost R1 Q303 HUMAN "blue")" \
  '{posts:{Q303:$q, R1:$r}}' >"$FAKE_DIR/thread-Q303.json"
bash "$script" 303 >/dev/null 2>&1
check "P3 nothing posted" "[ ! -s \"\$FAKE_DIR/posts.log\" ]"

# ---- P4: idle thread (current question consumed) — follow-up reply IN the thread
setup
mkissue 304 "issue body text"
jq -n '[{body:"agent: next I need to know the auth model — session or token?"}]' >"$FAKE_DIR/comments-304.json"
jq -n --argjson q "$(mkpost Q304 "" BOTID "$(ask_msg 304)")" '{posts:{Q304:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q304 "" BOTID "$(ask_msg 304)")" \
  --argjson r "$(mkpost R1 Q304 HUMAN "blue")" \
  --argjson c "$(mkpost C1 Q304 BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{Q304:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-Q304.json"
bash "$script" 304 >/dev/null 2>&1
rc=$?
check "P4 exit 0" "[ $rc -eq 0 ]"
check "P4 follow-up posted in thread" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && grep -q '\"root_id\": *\"Q304\"' \"\$FAKE_DIR/posts.log\""
check "P4 quotes newest comment" "grep -q 'session or token' \"\$FAKE_DIR/posts.log\""

# ---- P5: no comments — fall back to the issue body
setup
mkissue 305 "the body is the only context"
bash "$script" 305 >/dev/null 2>&1
check "P5 root ask posted from body" "grep -q 'the body is the only context' \"\$FAKE_DIR/posts.log\""

# ---- P6: root older than the lookback — fresh root, not a follow-up
setup
mkissue 306 "issue body text"
old_ms=$((now_ms - 200000 * 1000)) # > 48 h ago
jq -n --argjson q "$(mkpost Q306 "" BOTID "$(ask_msg 306)" "$old_ms")" '{posts:{Q306:$q}}' >"$FAKE_DIR/channel.json"
bash "$script" 306 >/dev/null 2>&1
check "P6 fresh root posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""

# ---- P7: env unset — exit 2, nothing called
setup
env -u MATTERMOST_BOT_TOKEN bash "$script" 307 >/dev/null 2>&1
rc=$?
check "P7 exit 2" "[ $rc -eq 2 ]"
check "P7 no calls" "[ ! -s \"\$FAKE_DIR/calls.log\" ]"

echo "post-issue-ask: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it — must fail (script missing)**

```bash
cd $OC && bash .sandcastle/tests/post-issue-ask-test.sh
```

Expected: FAILs (no `post-issue-ask.sh`).

- [ ] **Step 3: Write `$OC/.sandcastle/post-issue-ask.sh`**

```bash
#!/usr/bin/env bash
# Ensure a human-gated issue has an OUTSTANDING Mattermost ask — the
# answerable `:raising_hand:` question whose reply the resume sweep records on
# the issue and turns back into `ready-for-agent`. The idempotent primitive
# behind "the question reaches you in chat": run-triage.sh calls it straight
# after triage parks an issue, resume-parked-asks.sh calls it as the backstop.
#
# Thread model (per issue #N, shared with ask-human.sh): ONE conversation
# thread — the newest bot root post starting `:raising_hand:` naming #N within
# $ASK_HUMAN_LOOKBACK (48 h). A QUESTION is the root or any bot thread-reply
# starting `:raising_hand:`; the CURRENT question is the newest; it is
# CONSUMED once a bot `:white_check_mark:` follows it (create_at >=). So:
#   - current question unconsumed (answered or not) -> OUTSTANDING -> no-op;
#   - thread idle (current question consumed) -> post the next question as a
#     `:raising_hand:` THREAD REPLY — a design conversation's rounds stay in
#     one thread;
#   - no thread in the lookback -> post a fresh `:raising_hand:` root.
# The question text quotes the issue's NEWEST comment (triage and agents write
# what needs deciding there), falling back to the issue body.
#
# Usage: post-issue-ask.sh <issue-number>
# Exit:  0 posted or already outstanding; 2 chat or tracker env unset.
# Env: FORGEJO_TOKEN, FORGEJO_API (repo-scoped), MATTERMOST_URL,
#      MATTERMOST_CHANNEL_ID, MATTERMOST_BOT_TOKEN (or the bind-mounted
#      .sandcastle/secrets files — see secrets/README.md).
set -euo pipefail

n="${1:?usage: post-issue-ask.sh <issue-number>}"
lookback="${ASK_HUMAN_LOOKBACK:-172800}"

if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi

if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] ||
  [ -z "${MATTERMOST_CHANNEL_ID:-}" ] || [ -z "${FORGEJO_TOKEN:-}" ] ||
  [ -z "${FORGEJO_API:-}" ]; then
  echo "post-issue-ask: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID/FORGEJO_TOKEN/FORGEJO_API unset — cannot ask" >&2
  exit 2
fi

mm() { curl -sf -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$@"; }
fj() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

mm_post() { # mm_post <message> [root_id] — root_id makes it a thread reply
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" --arg root_id "${2:-}" \
    '{channel_id: $channel_id, message: $message}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
    mm -X POST -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts"
}

bot_id="$(mm "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"
chan="$(mm "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200")"
cutoff_ms=$((($(date +%s) - lookback) * 1000))
key="#$n"

root="$(jq -r --arg bot "$bot_id" --arg key "$key" --argjson cutoff "$cutoff_ms" \
  '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                      and .create_at >= $cutoff
                      and (.message | startswith(":raising_hand:"))
                      and (.message | test($key + "([^0-9]|$)")))]
   | sort_by(.create_at) | last | .id // empty' <<<"$chan")"

if [ -n "$root" ]; then
  thread="$(mm "$MATTERMOST_URL/api/v4/posts/$root/thread" || true)"
  if [ -z "$thread" ]; then
    # Can't judge the thread — do NOT risk a duplicate; the next sweep retries.
    echo "post-issue-ask: thread $root unreadable — skipping #$n this round" >&2
    exit 0
  fi
  outstanding="$(jq -r --arg root "$root" --arg bot "$bot_id" '
    ([.posts[] | select((.id == $root or .root_id == $root) and .user_id == $bot
                        and .delete_at == 0
                        and (.message | startswith(":raising_hand:")))]
     | max_by(.create_at) | .create_at) as $qts
    | [.posts[] | select(.root_id == $root and .user_id == $bot
                         and .delete_at == 0 and .create_at >= $qts
                         and (.message | startswith(":white_check_mark:")))]
    | length == 0' <<<"$thread")"
  if [ "$outstanding" = "true" ]; then
    echo "post-issue-ask: #$n already has an outstanding ask ($root) — nothing to do"
    exit 0
  fi
fi

issue="$(fj "$FORGEJO_API/issues/$n")"
title="$(jq -r .title <<<"$issue")"
url="$(jq -r .html_url <<<"$issue")"
excerpt="$(fj "$FORGEJO_API/issues/$n/comments" | jq -r 'last | .body // empty' | head -c 500)"
[ -n "$excerpt" ] || excerpt="$(jq -r '.body // ""' <<<"$issue" | head -c 500)"
quoted="$(sed 's/^/> /' <<<"$excerpt")"

body=":raising_hand: **Human decision needed** — reply **in this thread** to answer.
[#$n $title]($url)

$quoted

Your reply is recorded on the issue and it goes back to \`ready-for-agent\` (the resume sweep runs twice an hour)."

if [ -n "$root" ]; then
  mm_post "$body" "$root" >/dev/null
  echo "post-issue-ask: posted follow-up ask for #$n in thread $root"
else
  mm_post "$body" >/dev/null
  echo "post-issue-ask: posted new ask thread for #$n"
fi
```

Then `chmod +x $OC/.sandcastle/post-issue-ask.sh` (match sibling scripts' mode).

- [ ] **Step 4: Run the test — must pass**

```bash
cd $OC && bash .sandcastle/tests/post-issue-ask-test.sh
```

Expected: `post-issue-ask: N passed, 0 failed`.

- [ ] **Step 5: Add to the manifest**

Append to `$OC/.sandcastle/harness-manifest`:

```
# post-issue-ask.sh — the idempotent "this human-gated issue has an
# outstanding ask thread" primitive, called by run-triage.sh (question straight
# after triage) and resume-parked-asks.sh (backstop). Generic: no slug refs —
# everything comes from FORGEJO_API and the issue's own html_url.
file post-issue-ask.sh
```

- [ ] **Step 6: Run the sync-harness test (manifest consumers must still pass)**

```bash
cd $OC && bash .sandcastle/tests/sync-harness-test.sh
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
cd $OC && git add .sandcastle/post-issue-ask.sh .sandcastle/tests/post-issue-ask-test.sh .sandcastle/harness-manifest
git commit -m "sandcastle: post-issue-ask.sh — the outstanding-question primitive for human-gated issues (#asks-after-triage)"
```

---

### Task 3: `ask-human.sh` multi-round (ourcloud worktree)

**Files:**
- Modify: `$OC/.sandcastle/ask-human.sh`
- Modify: `$OC/.sandcastle/tests/test-ask-human.sh`

**Interfaces:**
- Consumes: fake curl `create_at` on created posts (Task 1).
- Produces: same CLI/exit contract; new behavior — consumed thread ⇒ follow-up `:raising_hand:` reply in that thread; replies matched per-round via `create_at >= q_ts`. Helper shapes shared with Task 4: `first_reply <thread_json> <root_id> <min_ts>`, `latest_question_ts <thread_json> <root_id>`, `consumed_after <thread_json> <root_id> <min_ts>`.

- [ ] **Step 1: Update the tests first**

In `$OC/.sandcastle/tests/test-ask-human.sh`:

(a) Let `mkpost` take an optional timestamp (5th arg), like the resume test's:

```bash
mkpost() { # mkpost <id> <root> <user> <msg> [create_at_ms]
  jq -n --arg id "$1" --arg root "$2" --arg user "$3" --arg msg "$4" \
    --argjson t "${5:-$now_ms}" \
    '{id:$id, root_id:$root, user_id:$user, message:$msg, create_at:$t, delete_at:0}'
}
```

(b) T5's fixture reply must postdate the freshly-posted question (whose `create_at` is now the fake's real-clock ms): change T5's `mkpost R1 NEWQ1 HUMAN "A please"` to `mkpost R1 NEWQ1 HUMAN "A please" $((now_ms + 60000))`.

(c) Replace T4 (was: consumed → new root) with consumed → follow-up in-thread:

```bash
# ---- T4: consumed — earlier round answered AND confirmed: next round joins
# the SAME thread as a follow-up reply; the old answer is never reused
setup
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" \
  --argjson r "$(mkpost R1 OLDQ HUMAN "A")" \
  --argjson c "$(mkpost C1 OLDQ BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{OLDQ:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-OLDQ.json"
ASK_HUMAN_TIMEOUT=2 bash "$script" "question about [#129 x](u)" >/dev/null 2>&1
rc=$?
check "T4 exit 3 (old answer not reused)" "[ $rc -eq 3 ]"
check "T4 posts a follow-up question" "grep -q raising_hand \"\$FAKE_DIR/posts.log\""
check "T4 follow-up joins the old thread" "grep raising_hand \"\$FAKE_DIR/posts.log\" | grep -q '\"root_id\": *\"OLDQ\"'"
check "T4 parking notice on the same thread" "grep hourglass \"\$FAKE_DIR/posts.log\" | grep -q '\"root_id\": *\"OLDQ\"'"
```

(d) Append T7 — a new answer to the follow-up round is picked up, the old round's answer is not:

```bash
# ---- T7: multi-round — follow-up in a consumed thread gets ITS OWN answer
setup
future_ms=$((now_ms + 3600000))
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" \
  --argjson r "$(mkpost R1 OLDQ HUMAN "A")" \
  --argjson c "$(mkpost C1 OLDQ BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  --argjson r2 "$(mkpost R2 OLDQ HUMAN "round two: use tokens" "$future_ms")" \
  '{posts:{OLDQ:$q, R1:$r, C1:$c, R2:$r2}}' >"$FAKE_DIR/thread-OLDQ.json"
out="$(ASK_HUMAN_TIMEOUT=5 bash "$script" "question about [#129 x](u)" 2>/dev/null)"
rc=$?
check "T7 exit 0" "[ $rc -eq 0 ]"
check "T7 returns the new round's answer" "[ \"$out\" = 'round two: use tokens' ]"
check "T7 confirms in the same thread" "grep white_check_mark \"\$FAKE_DIR/posts.log\" | grep -q '\"root_id\": *\"OLDQ\"'"
```

- [ ] **Step 2: Run — updated T4/T7 must fail against the old script**

```bash
cd $OC && bash .sandcastle/tests/test-ask-human.sh
```

Expected: T4/T7 FAIL (old script posts a new root), others pass.

- [ ] **Step 3: Rewrite `ask-human.sh`**

Replace `first_reply` (old two-arg version) with the three helpers, and replace the whole resume-scan + question-posting section (from `bot_id=…` down to the `waited=0` loop's `first_reply` call). Full new file content — the header comment changes too:

Lines 9–32 of the header become:

```bash
# Questions are RESUMABLE and MULTI-ROUND, keyed by the first issue reference
# (`#N`) in the question text. An issue's conversation lives in ONE thread:
# the newest bot root post starting `:raising_hand:` naming `#N` (within
# $ASK_HUMAN_LOOKBACK, default 48 h). Within a thread, a QUESTION is the root
# or any bot reply starting `:raising_hand:`; the CURRENT question is the
# newest; it is CONSUMED once a bot `:white_check_mark:` follows it. Before
# posting, every recent thread for the issue is judged by its current
# question, newest thread first:
#   - answered but not consumed (e.g. the reply arrived after the previous
#     poller died, in whichever thread the human happened to answer) — the
#     reply is returned immediately;
#   - unanswered and not consumed — polling resumes there; no duplicate
#     question is posted, an :eyes: note marks the live thread (2026-07-27:
#     seven duplicate asks for #129);
#   - consumed — the thread is idle; the NEW question is posted INTO it as a
#     `:raising_hand:` thread reply, so a design conversation's rounds stay
#     in one thread. Only when no thread exists at all does a fresh root get
#     posted.
# Replies are matched per ROUND: only thread posts at/after the current
# question's create_at count, so an earlier round's answer is never re-read.
#
# Only posts whose root_id is the thread root — i.e. replies inside its
# thread — and whose author is not the bot count as answers. Channel chatter
# and other threads are never picked up. The bot must be a MEMBER of the
# channel (posting works without membership; reading the thread does not).
#
# Exit codes: 0 reply received (stdout = reply text)
#             2 Mattermost env unset (chat not wired up)
#             3 timed out (parking notice posted) or interrupted/killed —
#               either way the round stays open and a later ask for the
#               same issue resumes it, so late replies are never lost.
```

Then, after the unchanged `post()` definition, the helpers:

```bash
first_reply() { # first_reply <thread_json> <root_id> <min_ts> — earliest human reply to the current round, or empty
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id != $bot and .delete_at == 0
                        and .create_at >= $min)]
     | sort_by(.create_at) | first | .message // empty' <<<"$1"
}

latest_question_ts() { # latest_question_ts <thread_json> <root_id> — create_at of the CURRENT question
  jq -r --arg root "$2" --arg bot "$bot_id" \
    '[.posts[] | select((.id == $root or .root_id == $root) and .user_id == $bot
                        and .delete_at == 0
                        and (.message | startswith(":raising_hand:")))]
     | max_by(.create_at) | .create_at // 0' <<<"$1"
}

consumed_after() { # consumed_after <thread_json> <root_id> <min_ts> — bot :white_check_mark: count at/after min_ts
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id == $bot and .delete_at == 0
                        and .create_at >= $min
                        and (.message | startswith(":white_check_mark:")))] | length' <<<"$1"
}
```

The resume-scan + posting section becomes:

```bash
bot_id="$(api "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"

# Resume path: judge every recent thread for the issue by its CURRENT question,
# newest thread first. A late reply anywhere wins; an open round resumes; the
# newest idle (fully-consumed) thread is where a follow-up question goes.
key="$(grep -oE '#[0-9]+' <<<"$question" | head -1 || true)"
qid=""
q_ts=0
idle=""
if [ -n "$key" ]; then
  chan="$(api "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200" || true)"
  if [ -n "$chan" ]; then
    cutoff_ms=$((($(date +%s) - lookback) * 1000))
    cands="$(jq -r --arg bot "$bot_id" --arg key "$key" --argjson cutoff "$cutoff_ms" \
      '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                          and .create_at >= $cutoff
                          and (.message | startswith(":raising_hand:"))
                          and (.message | test($key + "([^0-9]|$)")))]
       | sort_by(.create_at) | reverse | .[].id' <<<"$chan")"
    for cand in $cands; do
      thread="$(api "$MATTERMOST_URL/api/v4/posts/$cand/thread" || true)"
      [ -z "$thread" ] && continue
      qts="$(latest_question_ts "$thread" "$cand")"
      if [ "$(consumed_after "$thread" "$cand" "$qts")" -gt 0 ]; then
        [ -z "$idle" ] && idle="$cand"
        continue
      fi
      reply="$(first_reply "$thread" "$cand" "$qts")"
      if [ -n "$reply" ]; then
        post ":white_check_mark: Got it — picked up this earlier reply; proceeding with it." "$cand" >/dev/null
        printf '%s\n' "$reply"
        exit 0
      fi
      if [ -z "$qid" ]; then
        qid="$cand"
        q_ts="$qts"
      fi
    done
    if [ -n "$qid" ]; then
      post ":eyes: Waiting on **this thread** again (up to $((timeout / 60)) min) — reply here." "$qid" >/dev/null
      echo "ask-human: resuming open question $qid for $key — no duplicate posted" >&2
    fi
  fi
fi

if [ -z "$qid" ] && [ -n "$idle" ]; then
  # Idle conversation thread: the next round continues THERE, not in a new root.
  qpost="$(post ":raising_hand: **Follow-up** — reply **in this thread** to answer (waiting $((timeout / 60)) min).
$question" "$idle")"
  qid="$idle"
  q_ts="$(jq -r '.create_at // 0' <<<"$qpost")"
  echo "ask-human: posted follow-up question in thread $idle" >&2
elif [ -z "$qid" ]; then
  qpost="$(post ":raising_hand: **Human decision needed** — reply **in this thread** to answer (waiting $((timeout / 60)) min).
$question")"
  qid="$(jq -r .id <<<"$qpost")"
  q_ts="$(jq -r '.create_at // 0' <<<"$qpost")"
  echo "ask-human: posted question $qid" >&2
fi
echo "ask-human: waiting up to ${timeout}s for a thread reply on $qid" >&2
```

And the poll loop's pickup line changes from `first_reply "$thread" "$qid"` to:

```bash
  reply="$(first_reply "$thread" "$qid" "$q_ts")"
```

Everything else (env checks, trap, `:hourglass:` parking notice, exit codes) is unchanged.

- [ ] **Step 4: Run the tests — all pass**

```bash
cd $OC && bash .sandcastle/tests/test-ask-human.sh
```

Expected: `pass=N fail=0` (T1, T2, T3, T5, T6 prove no regression; T4, T7 prove multi-round).

- [ ] **Step 5: Commit**

```bash
cd $OC && git add .sandcastle/ask-human.sh .sandcastle/tests/test-ask-human.sh
git commit -m "sandcastle: ask-human rounds continue in the issue's ONE thread — per-question consumption replaces per-thread"
```

---

### Task 4: `resume-parked-asks.sh` per-question pickup + ask backstop (ourcloud worktree)

**Files:**
- Modify: `$OC/.sandcastle/resume-parked-asks.sh`
- Modify: `$OC/.sandcastle/tests/resume-parked-asks-test.sh`

**Interfaces:**
- Consumes: `post-issue-ask.sh <n>` (Task 2), the three helper shapes (Task 3), fake curl GETs (Task 1).
- Produces: same CLI/exit contract; per-question pickup; calls `post-issue-ask.sh` for every parked issue it did not re-arm.

- [ ] **Step 1: Update the tests first**

In `$OC/.sandcastle/tests/resume-parked-asks-test.sh`:

(a) `setup()` gains fixtures post-issue-ask needs (issue JSON per test below); add helper after `mkissue`:

```bash
mkissue_json() { # mkissue_json <number> — issue-<n>.json for post-issue-ask
  jq -n --argjson n "$1" \
    '{number:$n, title:"backup: movement-compose", html_url:("http://x/"+($n|tostring)), body:"fixture issue body"}' \
    >"$FAKE_DIR/issue-$1.json"
}
```

(b) T3 (consumed thread) — the backstop now posts a follow-up into the idle thread. Replace T3's checks with:

```bash
mkissue_json 205
jq -n '[{body:"triage: which storage backend do you want?"}]' >"$FAKE_DIR/comments-205.json"
# (insert the two lines above right after T3's setup; run line unchanged)
check "T3 consumed round not re-consumed" "! grep -q 'issues/205/labels' \"\$FAKE_DIR/calls.log\" && ! grep -q 'POST .*issues/205/comments' \"\$FAKE_DIR/calls.log\""
check "T3 follow-up ask posted in the idle thread" "grep raising_hand \"\$FAKE_DIR/posts.log\" | grep -q '\"root_id\": *\"Q205\"'"
check "T3 follow-up quotes newest comment" "grep -q 'which storage backend' \"\$FAKE_DIR/posts.log\""
```

(c) T4 (parked, no thread) — the backstop now posts a fresh root. Add after T4's `setup`:

```bash
mkissue_json 206
jq -n '[{body:"triage: is this in scope for v1?"}]' >"$FAKE_DIR/comments-206.json"
```

and replace T4's checks with:

```bash
check "T4 exit 0" "[ $rc -eq 0 ]"
check "T4 no issue writes" "! grep -q 'POST .*issues/206/comments' \"\$FAKE_DIR/calls.log\" && ! grep -q 'issues/206/labels' \"\$FAKE_DIR/calls.log\""
check "T4 root ask posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\""
check "T4 ask quotes the triage comment" "grep -q 'in scope for v1' \"\$FAKE_DIR/posts.log\""
```

(d) T5 (stale ask) — stale means "no thread in lookback", so the backstop posts a fresh root; the stale reply must still not be recorded. Add `mkissue_json 207` after T5's `setup`, keep the fixture, replace the check with:

```bash
check "T5 stale reply not recorded" "! grep -q 'POST .*issues/207/comments' \"\$FAKE_DIR/calls.log\" && ! grep -q 'issues/207/labels' \"\$FAKE_DIR/calls.log\""
check "T5 fresh root ask posted" "grep raising_hand \"\$FAKE_DIR/posts.log\" | grep -qv '\"root_id\"'"
```

(e) T6 — issue 208 is outstanding-unanswered (backstop no-ops); add `check "T6 no extra ask posted" "! grep -q raising_hand \"\$FAKE_DIR/posts.log\""`.

(f) Append T9 (multi-round pickup — the design-conversation case):

```bash
# ---- T9: multi-round — round 1 consumed, round 2 (follow-up) answered:
# record ROUND 2's answer, never round 1's
setup
t0=$now_ms t1=$((now_ms + 1000)) t2=$((now_ms + 2000)) t3=$((now_ms + 3000)) t4=$((now_ms + 4000))
jq -n --argjson i "$(mkissue 211)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q211 "" BOTID "$(ask_msg 211)" "$t0")" '{posts:{Q211:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q211 "" BOTID "$(ask_msg 211)" "$t0")" \
  --argjson a1 "$(mkpost A1 Q211 HUMAN "round one: option A" "$t1")" \
  --argjson c1 "$(mkpost C1 Q211 BOTID ":white_check_mark: Got it — proceeding with that answer." "$t2")" \
  --argjson q2 "$(mkpost Q2 Q211 BOTID ":raising_hand: **Follow-up** — which auth model?" "$t3")" \
  --argjson a2 "$(mkpost A2 Q211 HUMAN "round two: token auth" "$t4")" \
  '{posts:{Q211:$q, A1:$a1, C1:$c1, Q2:$q2, A2:$a2}}' >"$FAKE_DIR/thread-Q211.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T9 exit 0" "[ $rc -eq 0 ]"
check "T9 round-2 answer recorded" "grep -q 'round two: token auth' \"\$FAKE_DIR/forgejo.log\""
check "T9 round-1 answer NOT re-recorded" "! grep -q 'round one: option A' \"\$FAKE_DIR/forgejo.log\""
check "T9 re-armed" "grep -q 'issues/211/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[36\\]' \"\$FAKE_DIR/forgejo.log\""
check "T9 confirmation last" "tail -1 \"\$FAKE_DIR/calls.log\" | grep -q '/api/v4/posts\$'"
```

(T1, T2, T7, T8 stay as they are — T2's outstanding-unanswered issue makes the backstop a no-op, so its "nothing posted" check still holds.)

- [ ] **Step 2: Run — new/changed cases must fail against the old script**

```bash
cd $OC && bash .sandcastle/tests/resume-parked-asks-test.sh
```

Expected: T3/T4/T5 new checks and T9 FAIL; T1/T2/T6-T8 pass.

- [ ] **Step 3: Modify `resume-parked-asks.sh`**

(a) Header comment: replace the "For every open issue…" paragraph (lines 7–19) with:

```bash
# For every open issue labelled `ready-for-human`, judge its recent Mattermost
# ask threads by their CURRENT question (the thread model shared with
# ask-human.sh / post-issue-ask.sh: a bot root post starting `:raising_hand:`
# naming `#N` within $ASK_HUMAN_LOOKBACK; the current question is the newest
# bot `:raising_hand:` post in the thread; a bot `:white_check_mark:` at/after
# it consumes the round). If a round is answered but unconsumed:
#   1. the reply is copied onto the issue as the durable ruling record,
#   2. the issue is re-armed — `ready-for-agent` added (the label event fires
#      the swarm workflow), `ready-for-human` removed,
#   3. the thread is confirmed `:white_check_mark:` LAST — a crash mid-sweep
#      can park the issue re-armed with the thread unconsumed (the resumed
#      agent's own ask then recovers it), but can never consume a reply
#      without re-arming its issue.
# BACKSTOP: a parked issue the sweep did NOT re-arm gets post-issue-ask.sh —
# which posts the question thread if none is outstanding (none at all, or the
# newest thread is idle/consumed), quoting the issue's newest comment. So a
# `ready-for-human` issue ALWAYS has an answerable question in chat, and a
# design conversation keeps flowing round after round in one thread.
# Idempotent: a re-armed issue leaves the `ready-for-human` list, so it is
# never re-processed; a consumed round is never re-read; post-issue-ask.sh
# no-ops while a question is outstanding.
```

(b) After `set -euo pipefail` add:

```bash
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

(c) Replace the old two-arg `first_reply` with the three helpers — identical bodies to Task 3's `first_reply`/`latest_question_ts`/`consumed_after` (keep the `(verbatim from ask-human.sh)` note on `first_reply`).

(d) Replace the per-issue candidate loop body (the `for cand in $cands; do … done` block) with:

```bash
  hit=0
  for cand in $cands; do
    thread="$(mm "$MATTERMOST_URL/api/v4/posts/$cand/thread" || true)"
    [ -z "$thread" ] && continue
    qts="$(latest_question_ts "$thread" "$cand")"
    [ "$(consumed_after "$thread" "$cand" "$qts")" -gt 0 ] && continue
    reply="$(first_reply "$thread" "$cand" "$qts")"
    [ -z "$reply" ] && continue
```

…(steps 1–3 inside stay byte-identical to today)… and the block's tail becomes:

```bash
    echo "resume-parked-asks: re-armed #$n from thread $cand"
    rearmed=$((rearmed + 1))
    hit=1
    break
  done
  if [ "$hit" -eq 0 ]; then
    # Backstop: still parked, nothing picked up — make sure an answerable
    # question is outstanding (post-issue-ask no-ops if one already is).
    bash "$here/post-issue-ask.sh" "$n" || true
  fi
```

(`hit=0` initialization goes right after `key="#$n"` at the top of the per-issue loop.)

- [ ] **Step 4: Run the tests — all pass**

```bash
cd $OC && bash .sandcastle/tests/resume-parked-asks-test.sh
```

Expected: `resume-parked-asks: N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
cd $OC && git add .sandcastle/resume-parked-asks.sh .sandcastle/tests/resume-parked-asks-test.sh
git commit -m "sandcastle: resume sweep goes per-question and backstops every parked issue with an outstanding ask"
```

---

### Task 5: `run-triage.sh` asks straight after triage (ourcloud worktree) + final ourcloud commit

**Files:**
- Modify: `$OC/.sandcastle/run-triage.sh:84-96`

**Interfaces:**
- Consumes: `post-issue-ask.sh <n>` (Task 2).

- [ ] **Step 1: Replace the `:wave:` digest block**

Old block (`new="$(comm …)"` … `bash "$here/notify-mattermost.sh" "$msg"; fi`) becomes:

```bash
new="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
if [ -n "$new" ]; then
  digest=""
  while IFS=$'\t' read -r num label; do
    [ -z "$num" ] && continue
    if [ "$label" = ready-for-human ]; then
      # The answerable ask thread, straight after triage — quotes the triage
      # comment; the resume sweep records the reply and re-arms the issue.
      bash "$here/post-issue-ask.sh" "$num" || true
      continue
    fi
    issue="$(api "$FORGEJO_API/issues/$num")"
    title="$(jq -r .title <<<"$issue")"
    url="$(jq -r .html_url <<<"$issue")"
    digest="$digest
- [#$num $title]($url) → \`$label\`"
  done <<<"$new"
  if [ -n "$digest" ]; then
    bash "$here/notify-mattermost.sh" ":wave: **Triage needs you** in \`$repo_slug\`:$digest"
  fi
fi
```

(ourcloud's `needs-design` issues keep flowing into the digest; `ready-for-human` ones get real question threads.)

- [ ] **Step 2: Syntax-check and run the offline suite**

```bash
cd $OC && bash -n .sandcastle/run-triage.sh && bash .sandcastle/tests/post-issue-ask-test.sh && bash .sandcastle/tests/test-ask-human.sh && bash .sandcastle/tests/resume-parked-asks-test.sh && bash .sandcastle/tests/notify-test.sh && bash .sandcastle/tests/sync-harness-test.sh
```

Expected: all green.

- [ ] **Step 3: Commit and record the canonical SHA**

```bash
cd $OC && git add .sandcastle/run-triage.sh && git commit -m "sandcastle: triage-parked issues get their ask thread immediately — the :wave: digest keeps only needs-design"
git rev-parse HEAD   # → $CANON_SHA, needed by Task 6
```

---

### Task 6: matou-app — synced copies, per-repo edits, marker bump

**Files:**
- Modify: `matou-app/.sandcastle/ask-human.sh` (copy from `$OC`)
- Create: `matou-app/.sandcastle/post-issue-ask.sh` (copy from `$OC`)
- Modify: `matou-app/.sandcastle/resume-parked-asks.sh` (copy from `$OC` — identical file, no slug refs)
- Modify: `matou-app/.sandcastle/run-triage.sh` (same digest-block replacement as Task 5 Step 1, applied to lines 51–63; the `:mag:` verification block below it is untouched)
- Modify: `matou-app/.sandcastle/tests/fakebin/curl` (copy from `$OC` — Task 1 result; matou's extra `*/issues/[0-9]*` case is superseded by the method-aware one)
- Modify: `matou-app/.sandcastle/tests/test-ask-human.sh` (copy from `$OC`)
- Modify: `matou-app/.sandcastle/tests/resume-parked-asks-test.sh` (copy from `$OC`, then restore matou's one divergence: `export FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"`)
- Create: `matou-app/.sandcastle/tests/post-issue-ask-test.sh` (copy from `$OC`, same FORGEJO_API tweak)
- Modify: `matou-app/.sandcastle/.harness-canonical` (`rev=$CANON_SHA`)
- Modify: `matou-app/.sandcastle/prompt.md` (rule 4)

- [ ] **Step 1: Copy the files**

```bash
M=/home/benz/Documents/1.projects/matou-app/.sandcastle
cp $OC/.sandcastle/ask-human.sh $OC/.sandcastle/post-issue-ask.sh $OC/.sandcastle/resume-parked-asks.sh $M/
cp $OC/.sandcastle/tests/fakebin/curl $M/tests/fakebin/curl
cp $OC/.sandcastle/tests/test-ask-human.sh $M/tests/test-ask-human.sh
cp $OC/.sandcastle/tests/resume-parked-asks-test.sh $OC/.sandcastle/tests/post-issue-ask-test.sh $M/tests/
sed -i 's#repos/Matou/ourcloud#repos/Matou/matou-app#' $M/tests/resume-parked-asks-test.sh $M/tests/post-issue-ask-test.sh
```

- [ ] **Step 2: Apply the run-triage digest-block replacement** (identical code to Task 5 Step 1, replacing matou's lines 51–63; keep the `await`/`:mag:` blocks exactly as they are).

- [ ] **Step 3: Update prompt.md rule 4** — read the current rule first; the replacement keeps the timeout/parking sentences and adds ourcloud's exit-0 durable-record rule plus the multi-round note:

```
   `bash .sandcastle/ask-human.sh "Question about #<NUMBER>: <question>"`
   (give the Bash tool a 25-minute timeout per ask; when designing, several
   rounds are fine — each continues the issue's one Mattermost thread).
   **Exit 0**: stdout is the human's answer — comment the question *and*
   the answer onto the issue (the durable record; the next round's question
   is composed from the issue's newest comment). If it times out (exit 3):
   swap the issue's label `ready-for-agent` → `ready-for-human`, comment
   what you need, and stop working this issue — the resume sweep keeps the
   conversation going in the same thread.
```

- [ ] **Step 4: Bump the canonical marker**

```bash
sed -i "s/^rev=.*/rev=$CANON_SHA/" $M/.harness-canonical
```

- [ ] **Step 5: Run matou's offline suite**

```bash
cd /home/benz/Documents/1.projects/matou-app && bash -n .sandcastle/run-triage.sh && bash .sandcastle/tests/post-issue-ask-test.sh && bash .sandcastle/tests/test-ask-human.sh && bash .sandcastle/tests/resume-parked-asks-test.sh && bash .sandcastle/tests/check-verifications-test.sh && bash .sandcastle/tests/notify-test.sh
```

Expected: all green (check-verifications proves the `:mag:` flow untouched).

- [ ] **Step 6: Verify the copies are drift-clean** — `diff` each manifest file (`ask-human.sh`, `post-issue-ask.sh`) against `$OC`'s: must be byte-identical (slug transform is a no-op on them by construction).

- [ ] **Step 7: Commit (matou-app, on main)**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add .sandcastle docs/superpowers/specs/2026-08-06-triage-ask-threads-design.md docs/superpowers/plans/2026-08-06-triage-ask-threads.md
git commit -m "feat(sandcastle): triage-parked issues get answerable ask threads; rounds continue in one Mattermost thread"
```

---

### Task 7: Deploy ordering (pushes)

- [ ] **Step 1: Push ourcloud** — `git push origin harness/triage-ask-threads`, then fast-forward `main` to it (never squash: matou's marker pins `$CANON_SHA`): `git push origin harness/triage-ask-threads:main` if ff is allowed, otherwise merge with `--no-ff` (the SHA stays reachable either way).
- [ ] **Step 2: Push matou-app main** — `git push origin main`.
- [ ] **Step 3: Note for Ben** — the first sweep after deploy posts one ask per currently-parked `ready-for-human` issue (bounded, by design). Workflow YMLs are unchanged, so no schedule re-registration is needed.
- [ ] **Step 4: Clean up the worktree** — `git worktree remove <path>` once pushed (keep the branch).

## Self-Review Notes

- Spec §1 (thread model) → Tasks 2–4 helpers; §2 → Task 2; §3 → Tasks 5, 6 Step 2; §4 → Task 3; §5 → Task 4; §6 → Task 6 Step 3; sync/deploy → Tasks 6–7. No gaps.
- Helper names/signatures identical across Tasks 2, 3, 4 (`first_reply`, `latest_question_ts`, `consumed_after`; `post-issue-ask.sh <n>`).
- `>=` comparisons everywhere; fixtures with equal timestamps rely on it (T1 in both suites).
