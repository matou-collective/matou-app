# Factory TUI — a read-only monitor, plus four write actions

A Textual TUI over the swarm software factory: six tabs over the state the
harness in this directory's parent writes. **Mostly a read-only monitor**,
plus four deliberate write actions (Cancel, arm/park/prioritise, rearm
dispatch, answer a parked ask).

Vendored like every other harness file, so every consumer gets the same
monitor. **Nothing under `tui/` names a repo, a host or a product path**:
every per-repo and per-host value is resolved at start-up by
`data/identity.py` from the identity layer beside this directory. Run it from
a consumer's `.sandcastle/tui/` and it shows THAT repo's factory; run it from
the factory's own checkout and it shows this repo's. The header's subtitle is
the repo slug it resolved, so which factory you are looking at is never a
guess.

**Scope: one host, one repo.** The Monitor/Run tabs read the local
`swarm.db`, so the TUI shows the state of the host it runs on. A fleet-wide
view (every enrolled host's db, via the host registry) is a follow-up, not
this version.

## Run it

See `onboarding/README.md` in the factory repo — the operator entry point,
including the venv setup and which credentials each tab needs. In short:
`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then
`FORGEJO_TOKEN=... .venv/bin/python app.py` from this directory.

## Where each value comes from

`data/identity.py` sources the sibling shell files that already OWN each
default, rather than re-deriving them in Python — so the TUI cannot drift
from the scripts it monitors, and the process environment keeps its usual
precedence (exporting `CLAUDE_LIMIT_MARKER` moves the TUI's marker exactly as
it moves the harness's).

| value | resolved from |
| --- | --- |
| tracker API base, repo slug, checkout | `swarm-identity.sh` (`FORGEJO_API`, `REPO_SLUG`, `HEAL_WORKDIR`) |
| Claude limit / active-account markers | `limit-lib.sh` (`CLAUDE_LIMIT_MARKER`, `CLAUDE_ACTIVE_MARKER`) |
| cancel-marker dir | `cancel-lib.sh` (`SWARM_CANCEL_DIR`) |
| `swarm.db` | `swarm-db-lib.sh` (`SWARM_DB`) |
| healer ledger dir | `heal.sh`'s own default off `HEAL_WORKDIR`, or `HEALER_STATE` |
| drive-status record | `DRIVE_STATUS_FILE`, declared by a consumer that runs a rehearsal drive — the harness writes no such file, so there is no default |
| swarm workflow to re-arm | `SWARM_WORKFLOW_FILE`, default `swarm.yml` |
| chat (Inbox tab) | `MATTERMOST_URL` / `MATTERMOST_CHANNEL_ID` / `MATTERMOST_BOT_TOKEN`, or the bind-mounted `secrets/mattermost_bot_token` |

A value the identity layer does not resolve is **stated, never guessed**: the
Queue and Inbox tabs say which variable is missing and how to regenerate the
identity file, the drive panel says no `DRIVE_STATUS_FILE` was declared, and
Cancel refuses rather than writing a marker into an invented directory that
nothing polls.

The drive-status record is the one input a **consumer** writes, so its keys are
that repo's schema, not the factory's. The panel prefers `box_name` / `box_ip`
— the factory's shape-neutral vocabulary for the machine a drive stands up
(`CONTEXT.md`: **Box**) — and still reads the older spelling a repo may already
be writing, `droplet_name` / `droplet_ip`, <!-- box-vocabulary-waiver (#53) -->
since the topology is pull-only and a rename here could only blank a live
writer's panel (GOTCHAS 20). `target` is printed verbatim: that field is the
consumer's own word for what it drove.

`FORGEJO_TOKEN` is needed for the Queue and Inbox tabs' tracker half; the
Monitor tab works without it. Without the chat credentials every Inbox row
reads `chat-unavailable` instead of erroring — its Forgejo half still shows.

## The worker-class table

`worker-classes.json` beside this README is the **harness's own** worker
classes — the workers whose code lives in the factory repo. It deliberately
declares no hosts: which machine runs which class is a per-deployment fact.

A consumer adds `worker-classes.local.json` to its identity layer (beside
`swarm-identity.sh`) to declare its hosts and any class only it runs.
Entries merge by `id` — a known id has its fields overridden (so declaring
`hosts` leaves the vendored description intact), a new id is appended:

```json
{"classes": [
  {"id": "healer", "hosts": ["host-a"]},
  {"id": "my-own-worker", "name": "my own worker", "hosts": ["host-b"],
   "trigger": "cron */10", "invisible_failure": true}
]}
```

A class with no declared hosts still gets one row, host `-` — an undeclared
host is a gap to see, not to hide.

## The tabs

- **Monitor** — recent runs (`swarm.db`), live drive status, limit/account
  state. 5s refresh.
- **Queue** — every open tracker issue, classified by its ADR 0174 triage
  pipeline label (`ready-for-agent` / `ready-for-session` / `ready-for-human`
  / `needs-design` / `needs-triage` / `agent-blocked` / `deferred` /
  `in-progress` for `agent-working`), with DAG-blocker numbers for any
  `ready-for-agent` issue the dependency graph still blocks — mirrors
  `list-ready-tasks.sh`'s own filter, unfiltered to show the whole queue. Own
  30s interval (network-bound); a fetch failure shows inline in
  `#queue-error` rather than crashing the app.
  With a row selected: `a` arms it (adds `ready-for-agent`, removes
  `ready-for-human` — the pair `resume-parked-asks.sh` posts on its own
  sweep), `p` parks it (the reverse), `i` toggles the additive `priority`
  label. Each is a two-keypress arm/confirm within
  `LABELOP_CONFIRM_WINDOW` (5s), scoped to the Queue tab and to the exact
  (action, issue) pair armed — a stray second press on another row re-arms
  instead of confirming. Label ids are resolved once via `GET /labels`
  (paginated past 50, per `claim-lib.sh`'s `claim_label_id` finding) and
  cached for the app's lifetime.
  `r` arms a fresh swarm dispatch — `r` again within 5s POSTs `{"ref":"main"}`
  to `/actions/workflows/<swarm workflow>/dispatches`, the same call
  `claim-lib.sh`'s `rearm_dispatch` makes when claimable work remains after a
  run, fired on demand instead of waiting for the next cron tick. No row
  selection: the armed state is a bare timestamp.
- **Run** — live run detail: every `attempts` row (issue/iteration/status/
  close_outcome, newest first) and every open `processes` row (no `ended_at`
  — the wedge marker: believed still alive). 5s refresh. Press `c` to arm
  cancelling the currently-live run (the `runs` row with no `ended_at`), `c`
  again within 5s to confirm — writes the marker file `main.mts` polls for
  and stops within seconds. `c` outside this tab, or with no live run, is a
  no-op. (ADR 0186)
- **Fleet** — hosts × worker classes (host, trigger, lock, whether the class
  fails invisibly, its stuck-signal — or lack of one), one row per (host,
  class) pair, from the vendored table merged with the repo's overlay.
  Doc-maintained data, not live host state: loaded once on mount, no polling,
  no db/network dependency.
- **Incidents** — the healer's incident ledger (`heal-lib.sh`'s ledger, one
  file per signature under `$HEALER_STATE`): signature, workflow, first/last
  seen, attempts, replies, repaired, escalated, thread id — newest `last_seen`
  first. 5s refresh; a missing ledger dir reads as zero incidents, same
  posture as every other reader. Filters strictly to 12-hex-char signature
  filenames: a live ledger dir also holds a `retired/` subdirectory (manual
  triage) and loose `<sig>.chanmove-bak` files (ad-hoc host cruft, written by
  no committed script) that must never be read as incidents.
- **Inbox** — parked `ask-human.sh` threads: every open `ready-for-human`
  issue crossed with its chat ask-thread state — `outstanding` (posted,
  nobody's replied), `answered-pending-sweep` (a reply landed but
  `resume-parked-asks.sh` hasn't picked it up yet, with a preview), `idle`
  (the current question is already consumed — still showing here is itself a
  signal), `no-thread` (nothing in the 48h lookback), or `chat-unavailable`.
  Own 30s interval and inline `#inbox-error` panel — this screen crosses two
  APIs, neither of them local host state. The thread-state logic (candidate
  selection, current-question, consumed-vs-outstanding) mirrors
  `ask-human.sh` / `post-issue-ask.sh` / `resume-parked-asks.sh`'s own jq
  exactly, since there is no local marker file to read instead: the
  idempotency is entirely thread-state-derived.
  With an `outstanding` row selected, `w` opens a text `Input`, Enter
  submits — `data/answer_ask.py`'s `answer()` records the text as a durable
  issue comment, re-arms `ready-for-agent` (composing `data/labels.py`'s
  `arm`), posts the text into the ask thread as a reply, then closes the
  thread with `:white_check_mark:` **last**, so a crash can never mark a
  thread consumed without the answer being recorded and the issue re-armed
  (the ordering invariant `resume-parked-asks.sh` itself protects). `Escape`
  cancels; any other row state reports why there is nothing to answer.

## Test

```
.venv/bin/python -m pytest tests/ -v
```

Offline: no network call in the suite, and no host value reaches an
assertion — `tests/test_app.py` injects a whole synthetic identity layer,
and `tests/test_identity.py` builds a fake harness dir (real bash, fake
files) rather than reading the host's. `tests/test_swarmdb.py` and
`tests/test_app.py` seed a scratch `swarm.db` by shelling out to the real
`swarm-db.py` one directory up (the production writer), not a hand-copied
schema, so a schema drift fails these tests too. Every tracker/chat test
injects a fake `fetch`/`poster`/`deleter`; live-smoke-verify against the real
APIs when touching `data/tracker.py`, `data/ask_inbox.py`, `data/labels.py`
or `data/answer_ask.py`.

`data/rearm.py` is deliberately NOT live-smoke-verified: a real
`workflow_dispatch` POST has no disposable equivalent — it kicks an actual
swarm run (real compute, real ticket claims), so firing one to prove the
Python mirror's shape would BE the write action, not a proof of it. It posts
the same body to the same path `forgejo-lib.sh`'s `forgejo_dispatch_workflow`
and `claim-lib.sh`'s `rearm_dispatch` post in production every time
`run-swarm.sh` finds claimable work left after a run — a shape proven live
daily by the bash it mirrors.

`tests/tui-test.sh` in the factory's own `tests/` runs this suite from the
repo's offline suite when a venv or a system pytest is available, and says so
loudly when it is not.

## Known gaps (ticket separately — not stubs)

- **One host, one repo.** The Monitor/Run tabs read the local `swarm.db`
  only; a fleet-wide read across every enrolled host is not built.
- The label-id cache is populated once, lazily, on the first
  arm/park/prioritise confirm and never invalidated — a label renamed or
  deleted on the tracker mid-session needs an app restart, not just a retry.
- The Queue/Inbox fetches run synchronously on Textual's main thread, so a
  slow or hanging API call visibly stalls the UI for that refresh. The fix is
  a `run_worker(thread=True)` + `call_from_thread` split, not attempted here.
