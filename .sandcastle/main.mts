import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBranchStrategy } from "./branch-strategy.mts";

// Simple loop: an agent that picks ready tasks one by one and closes them.
// Task source: .sandcastle/list-ready-tasks.sh (Forgejo, DAG-filtered) via the
// shell expression in prompt.md. Run with: npm run sandcastle

// The model is NOT hardcoded here (#448, learning L6): it is read from
// .sandcastle/swarm.config — the SAME KEY=value file heal.sh sources via
// model-lib.sh — so the worker and the healer can never drift to different
// models. Parse it directly (node can't source bash) into the fleet default
// plus the allowlist (the map values).
function readSwarmConfig(): { default: string; allowed: Set<string> } {
  const text = readFileSync(new URL("./swarm.config", import.meta.url), "utf8");
  const kv: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    kv[line.slice(0, eq).trim()] = value;
  }
  const def = kv.SWARM_MODEL;
  if (!def) throw new Error(".sandcastle/swarm.config: SWARM_MODEL is unset");
  const allowed = new Set<string>([def]);
  for (const pair of (kv.SWARM_MODEL_MAP ?? "").split(/\s+/).filter(Boolean)) {
    const id = pair.slice(pair.indexOf("=") + 1);
    if (id) allowed.add(id);
  }
  return { default: def, allowed };
}

// run-swarm.sh resolves the first ready ticket's model-<name> label to a full id
// (defaulting to the config default) and exports it as SWARM_MODEL before
// launching us; `npm run sandcastle` run directly with no env falls back to the
// config default. Either way the model MUST be in the allowlist — an unlisted id
// fails LOUD here, before any worker container spawns (#448 fail-fast).
function resolveSwarmModel(): string {
  const { default: def, allowed } = readSwarmConfig();
  const model = process.env.SWARM_MODEL?.trim() || def;
  if (!allowed.has(model)) {
    throw new Error(
      `SWARM_MODEL="${model}" is not an allowed model ` +
        `(swarm.config allowlist: ${[...allowed].join(", ")}). ` +
        `Fix the model-* label / swarm.config; never launch on an unlisted model.`,
    );
  }
  return model;
}

const SWARM_MODEL = resolveSwarmModel();
console.log(`worker: launching on model ${SWARM_MODEL}`);

// Factory git identity (#19): run-swarm.sh stamps GIT_AUTHOR_*/GIT_COMMITTER_*
// into our process env (swarm-identity.sh's swarm_git_identity, class `worker`,
// naming the HOST) before launching us. Forward those into the worker container
// so its commits record "…(worker@<host>)" instead of inheriting the container
// user's git config. Absent on a bare `pnpm run sandcastle` — then we inject
// nothing and git falls back to its usual config, same best-effort posture as
// SWARM_DB_RUN_ID below.
//
// CLAUDE_ACCOUNT_FP (#223, follow-up to #200): the fingerprint of the Claude
// token this run selected, exported by execute-lib.sh's claude_select_token
// before it launches us (and re-exported on a mid-run failover, which re-runs
// `pnpm run sandcastle` so we re-read it here). Forwarded so the container's
// prepare-commit-msg hook can stamp the `Factory-Account: <fp>` trailer onto the
// worker's commits — per-account attribution in `git log`, keyed by the same
// fingerprint #200 already keys the limit markers and spend rows by. The token
// itself NEVER crosses this boundary: only its fingerprint, exactly as the
// claude-fence shim computes it in-container for its own protocol line.
function factoryGitIdentityEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "CLAUDE_ACCOUNT_FP",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

// #612 (idss ADR 0186): operator-cancel kill-path. SWARM_DB_RUN_ID is the
// SAME run_db_id run-swarm.sh's swarm.db writes already use (read early here,
// not only at the bottom for the #574 mirror, so it can also name this run's
// cancel marker) — moved up from its original spot below the run() call.
// Absent (a bare `pnpm run sandcastle` outside run-swarm.sh) means there is no
// run_id to name a marker after, so cancellation is simply unavailable on that
// path — consistent with #574's own "best-effort, run-swarm.sh-only" posture.
const swarmDbRunId = process.env.SWARM_DB_RUN_ID;

// One marker file per run_id, host-local, under the SAME $HOME/swarm/state/
// home swarm.db itself already uses (never .sandcastle/, never synced) — the
// TUI's data/cancel.py writes it; this poll consumes it. See ADR 0186 §1 for
// why a marker file rather than a new IPC mechanism.
const CANCEL_DIR = process.env.SWARM_CANCEL_DIR ?? `${process.env.HOME}/swarm/state/cancel-request`;
function cancelMarkerPath(runId: string): string {
  return `${CANCEL_DIR}/${runId}`;
}

const cancelController = new AbortController();
let cancelReason: string | undefined;
let cancelTimer: ReturnType<typeof setInterval> | undefined;
if (swarmDbRunId) {
  const markerPath = cancelMarkerPath(swarmDbRunId);
  // A poll, not a filesystem watch (no new dependency, trivially testable as
  // a pure predicate) — Sandcastle's own `signal` contract offers no finer
  // latency guarantee than "checked at phase boundaries" anyway (ADR 0186 §1).
  // `.unref()`'d so a pending poll can never itself keep the process alive
  // past every other exit path (normal completion, a genuine crash) — the
  // ONE thing that must never regress by adding this.
  cancelTimer = setInterval(() => {
    if (!existsSync(markerPath)) return;
    try {
      cancelReason = readFileSync(markerPath, "utf8");
    } catch {
      cancelReason = "";
    }
    try {
      rmSync(markerPath);
    } catch {
      // best-effort consume — a marker that outlives its run is harmless
      // (run_id is unique per run), just untidy.
    }
    clearInterval(cancelTimer);
    cancelController.abort(new Error(`operator cancel via the factory TUI (#612)`));
  }, 2000);
  cancelTimer.unref();
}

// #111: the mid-run drive yield. run-swarm.sh consults the drive reservation
// (`/tmp/matou-drive-wanted`, ADR 0184 / #663) ONCE, before taking the host
// slot; the loop below then drains up to maxIterations tasks, each in a fresh
// sandbox, with nothing re-checking it — a queue-draining run held slot 2 for
// hours while a ready rehearsal drive skipped 20+ ticks. Sandcastle offers no
// between-iteration host hook, and its abort signal kills the in-flight agent,
// so the reservation is MIRRORED instead: this host-side poller (2 s, like the
// cancel marker's) writes `drive-wanted` into a run-scoped host dir that every
// sandbox sees read-only at /run/host-signals; list-ready-tasks.sh answers []
// when the file is there, so claim-next-task.sh claims nothing more and the
// prompt's "Done" re-check completes the loop after the CURRENT task. On exit
// a marker line tells execute-lib.sh the run stood down (reason=yielded-to-
// drive); the work that was finished lands exactly as a completed run's does.
const DRIVE_WANTED = process.env.HOST_CAPACITY_DRIVE_WANTED ?? "/tmp/matou-drive-wanted";
const DRIVE_WANTED_TTL_S = Number(process.env.HOST_CAPACITY_DRIVE_WANTED_TTL ?? "900") || 900;
const HOST_SIGNALS_DIR =
  process.env.SWARM_HOST_SIGNALS_DIR ?? `${tmpdir()}/matou-host-signals-${swarmDbRunId ?? String(process.pid)}`;
const DRIVE_SIGNAL = `${HOST_SIGNALS_DIR}/drive-wanted`;
mkdirSync(HOST_SIGNALS_DIR, { recursive: true });
try {
  rmSync(DRIVE_SIGNAL); // a stale signal from a crashed run must not silence this one
} catch {
  // absent
}
// The same freshness rule as host_capacity_drive_wanted (host-capacity-lib.sh):
// present AND mtime younger than the TTL — an expired reservation is not one.
function driveWantedFresh(): boolean {
  try {
    return (Date.now() - statSync(DRIVE_WANTED).mtimeMs) / 1000 < DRIVE_WANTED_TTL_S;
  } catch {
    return false;
  }
}
let driveYieldArmed = false;
const driveTimer = setInterval(() => {
  if (driveWantedFresh()) {
    if (driveYieldArmed) return;
    driveYieldArmed = true;
    try {
      writeFileSync(DRIVE_SIGNAL, "");
    } catch {
      // best effort — the next tick retries
      driveYieldArmed = false;
      return;
    }
    console.log(
      "worker: a rehearsal drive reserved host capacity mid-run (#111) — finishing the current task, then claiming nothing more",
    );
  } else if (driveYieldArmed) {
    driveYieldArmed = false;
    try {
      rmSync(DRIVE_SIGNAL);
    } catch {
      // already gone
    }
    console.log("worker: the drive reservation cleared — claiming resumes");
  }
}, 2000);
driveTimer.unref();

// #213 (swarm fairness): the peer-repo want-file mirror — the generalisation of
// the #111 drive mirror above. A PEER repo's swarm has starved past its yield
// threshold and declared a host-side want-file (`/tmp/matou-repo-wanted-<slug>`,
// swarm-yield-signal.sh over swarm-yield-lib.sh); list-ready-tasks.sh answers []
// for a run whose slug is NOT the want-file's, so this draining run claims
// nothing more and frees the shared host slot after its current ticket. Those
// want-files live on the HOST; a sandbox only sees HOST_SIGNALS_DIR read-only,
// so — exactly like the drive reservation — this host-side poller copies every
// FRESH peer want-file into `HOST_SIGNALS_DIR/repo-wanted-<slug>` and removes the
// mirror of any that went stale or away. This run's OWN want-file (this repo
// starving) is EXCLUDED: a run must never yield to itself. The dir of want-files
// and the slug→tag keying match swarm-yield-lib.sh's `swarm_repo_wanted_path`
// (`<slug>` with every `/` turned to `-`); the mirror filename is the
// `repo-wanted-<tag>` contract list-ready-tasks.sh matches on.
const REPO_WANTED_DIR = process.env.HOST_CAPACITY_REPO_WANTED_DIR ?? "/tmp";
const REPO_WANTED_PREFIX = "matou-repo-wanted-";
const REPO_WANTED_MIRROR_PREFIX = "repo-wanted-";
const ownRepoTag = (
  process.env.REPO_SLUG || (process.env.FORGEJO_API ?? "").replace(/^.*\/repos\//, "")
).replace(/\//g, "-");
// Same freshness rule as the drive reservation (host_capacity_drive_wanted):
// present AND mtime younger than the TTL — an expired want-file is not one.
function repoWantedFresh(p: string): boolean {
  try {
    return (Date.now() - statSync(p).mtimeMs) / 1000 < DRIVE_WANTED_TTL_S;
  } catch {
    return false;
  }
}
// Reconcile the mirror to the host's live peer want-files: write the ones that
// should be mirrored, remove the ones that should not. Idempotent, best-effort —
// a failed write/remove is simply retried on the next 2 s tick.
function reconcileRepoWanted(): void {
  const wanted = new Set<string>();
  try {
    for (const name of readdirSync(REPO_WANTED_DIR)) {
      if (!name.startsWith(REPO_WANTED_PREFIX)) continue;
      const tag = name.slice(REPO_WANTED_PREFIX.length);
      if (!tag || tag === ownRepoTag) continue; // never mirror our own want-file
      if (repoWantedFresh(`${REPO_WANTED_DIR}/${name}`)) wanted.add(tag);
    }
  } catch {
    // the want-file dir is absent on a host that has never signalled — nothing
    // to mirror; fall through to clear any mirror left from a previous tick.
  }
  for (const tag of wanted) {
    const dst = `${HOST_SIGNALS_DIR}/${REPO_WANTED_MIRROR_PREFIX}${tag}`;
    if (existsSync(dst)) continue;
    try {
      writeFileSync(dst, "");
    } catch {
      // best effort — the next tick retries
    }
  }
  try {
    for (const name of readdirSync(HOST_SIGNALS_DIR)) {
      if (!name.startsWith(REPO_WANTED_MIRROR_PREFIX)) continue; // leave drive-wanted/start-sha/run-landing untouched
      if (wanted.has(name.slice(REPO_WANTED_MIRROR_PREFIX.length))) continue;
      try {
        rmSync(`${HOST_SIGNALS_DIR}/${name}`);
      } catch {
        // already gone
      }
    }
  } catch {
    // HOST_SIGNALS_DIR was mkdir'd above; ignore a transient read error.
  }
}
// Seed once synchronously so the first iteration's lister sees a peer that was
// already starving at launch, with no 2 s gap; then poll like the drive mirror.
reconcileRepoWanted();
const repoWantedTimer = setInterval(reconcileRepoWanted, 2000);
repoWantedTimer.unref();

// driveMirrorStop — on every exit path: stop BOTH host-signal pollers (the #111
// drive mirror and the #213 peer-want mirror), emit the drive marker if the run
// ended while a reservation stood, and remove the run-scoped dir (which clears
// every mirror it holds).
function driveMirrorStop(): void {
  clearInterval(driveTimer);
  clearInterval(repoWantedTimer);
  if (driveYieldArmed) {
    console.log(`SANDCASTLE_YIELDED_TO_DRIVE run=${swarmDbRunId ?? "unknown"}`);
  }
  try {
    rmSync(HOST_SIGNALS_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

let result;
try {
  result = await run({
    // A name for this run, shown as a prefix in log output.
    name: "worker",

    // Sandbox provider — runs the agent inside an isolated container.
    // `mounts` delivers every bearer token — FORGEJO_TOKEN, MATTERMOST_BOT_TOKEN,
    // DIGITALOCEAN_ACCESS_TOKEN, and (since #198) the Claude OAuth token — as
    // read-only files under /run/secrets instead of forwarding them as `-e`
    // env vars, which land in `docker inspect .Config.Env`, readable by anyone
    // with Docker API access (the 2026-07-11 breach vector; see
    // docs/SECRETS_CHECKLIST.md). run-swarm.sh materializes .sandcastle/secrets/*
    // from its own process env before every run. The `claude` CLI only accepts
    // its token as CLAUDE_CODE_OAUTH_TOKEN (no file-based flag), so the Dockerfile
    // installs a `claude` shim (claude-fence) first on PATH that reads the mounted
    // secrets/claude_oauth_token file and execs the real CLI with it in the child
    // env only — the token never appears in the container's inspectable env.
    sandbox: docker({
      mounts: [
        { hostPath: ".sandcastle/secrets", sandboxPath: "/run/secrets", readonly: true },
        // Persistent pnpm store shared by every worker container: the sandbox
        // installs from here instead of re-downloading the registry each
        // iteration. run-swarm.sh creates the dir beside secrets/.
        { hostPath: ".sandcastle/pnpm-store", sandboxPath: "/home/agent/.pnpm-store", readonly: false },
        // Persistent nix store shared by every worker container: the #198 Go
        // pre-push gate's `nix develop .#go-ci` finds the ADR-0040 pinned toolchain
        // already substituted here instead of re-downloading it from the binary
        // cache per container (#249 — the 110/116/161-min tail). run-swarm.sh
        // creates AND seeds .sandcastle/nix-store from the image's own /nix before
        // the first worker mounts it (a bare empty mount would hide Nix itself);
        // the global swarm flock admits one heavy worker per host, so concurrent
        // writes to the shared store are already fenced.
        { hostPath: ".sandcastle/nix-store", sandboxPath: "/nix", readonly: false },
        // The worktrees dir, mounted at its HOST path (issue #239, Ben's option 1).
        // A linked worktree's admin back-link (.git/worktrees/<name>/gitdir) names
        // the worktree's host path; the parent .git is already mounted at its host
        // path, so with this mount the back-link resolves identically on host and
        // in the sandbox. libgit2 (nix flake evaluation, the #198 gate) is
        // satisfied without anyone rewriting shared admin state — the in-container
        // rewrite (93c6afb) corrupted the host's view and reded every merge-to-head
        // from run 1654 on. The git-fence shim (Dockerfile) remains the backstop
        // against workers running `git worktree` admin commands.
        { hostPath: ".sandcastle/worktrees", sandboxPath: `${process.cwd()}/.sandcastle/worktrees`, readonly: false },
        // #111: the host's drive-reservation mirror — read-only, run-scoped.
        { hostPath: HOST_SIGNALS_DIR, sandboxPath: "/run/host-signals", readonly: true },
      ],
    }),

    // The agent provider. The model is the shared SWARM_MODEL resolved above (no
    // hardcoded id — #448): the fleet default balances capability against
    // subscription quota for continuous swarm use (fable exhausted the usage
    // window in ~14 h on 2026-07-25; the run-swarm limit guard now handles that
    // gracefully, but the default stretches the window), and a ticket's model-*
    // label can right-size a mechanical ticket down via run-swarm.sh.
    // The agent provider injects the factory git identity (#19) into the
    // sandbox so worker commits carry the machinery's provenance, not the
    // container user's git config.
    agent: claudeCode(SWARM_MODEL, { env: factoryGitIdentityEnv() }),

    // Path to the prompt file. Shell expressions inside are evaluated inside the
    // sandbox at the start of each iteration, so the agent always sees fresh data.
    promptFile: "./.sandcastle/prompt.md",

    // Maximum number of iterations (agent invocations) to run in a session.
    // Each iteration works on a single issue. ONE since #301 (Ben's ruling,
    // 2026-10-22): a run is one ticket. The order tickets are worked in is
    // fleet-wide — priority, then filing date, across every consumer repo, a
    // closed ticket's dependants first — and that order is decided OUTSIDE the
    // run (fleet-queue.sh dispatches one repo for one ticket). A run that drained
    // its own repo's list for three iterations would claim its second and third
    // tickets ahead of an older ticket waiting in another repo, so the fleet
    // order held only at dispatch and leaked inside every run. The successor is
    // dispatched by the self-rearm (report-lib.sh), so throughput is unchanged;
    // what a longer run saved was one dispatch + one leg per ticket.
    maxIterations: 1,

    // Branch strategy — LANDING-aware (#230; branch-strategy.mts has the full
    // why). merge-to-head runs the agent on a temp worktree branch and merges
    // it back to HEAD (`main`) when the run completes — right under
    // LANDING=push, where `main` is the landing surface. Under LANDING=pr the
    // landing already happened via the worker's pull request, so that post-run
    // merge is redundant AND is the thing that reds the run on a STATUS.md
    // concurrent-write conflict (SyncError; GOTCHAS 72): there we pin the
    // worktree to a per-run-unique NAMED branch, which Sandcastle collects
    // commits from but never merges onto `main`. The temp branch is discarded
    // by the next run's `git reset --hard origin/main`, like the
    // `sandcastle/worker/*` branches merge-to-head already leaves behind.
    branchStrategy: resolveBranchStrategy(
      process.env.SWARM_POLICY_LANDING,
      `sandcastle/worker/${new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`,
    ),

    // node_modules is NOT copied from the host: the host's pnpm layout records
    // host store paths in .modules.yaml, so inside the container pnpm demands a
    // purge-and-reinstall anyway (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY,
    // 2026-07-27). The sandbox installs fresh from the mounted persistent store
    // instead — warm after the first run, seconds thereafter.

    // Lifecycle hooks — commands grouped by where they run (host or sandbox).
    hooks: {
      sandbox: {
        // onSandboxReady runs once after the sandbox is initialised and the repo is
        // synced in, before the agent starts. CI=true keeps pnpm non-interactive;
        // frozen: the lockfile is the contract — a dependency change that forgot
        // its lockfile update should fail loudly here, not be papered over.
        onSandboxReady: [
          // No worktree back-link alignment here: the worktrees mount (above) makes
          // the host-recorded back-link resolve in the sandbox as-is. Any write to
          // the shared .git/worktrees/ admin from inside the container persists to
          // the host and breaks merge-to-head after the container exits (93c6afb).
          // timeoutMs sizes the ceiling off the MEASURED right tail, not the
          // library default. Sandcastle's per-command default is 60_000ms, but
          // the observed install max across 1019 warm-store setups is 46.5s —
          // only 1.3x under that cap, so ordinary host contention (the 2-wide
          // swarm matrix plus concurrent triage/resume/publish jobs share one
          // workstation and one host-mounted pnpm store) tips a slow-but-healthy
          // install over the edge and reds the whole run with a HookTimeoutError
          // (idss #1142; GOTCHAS). 300_000ms (5 min) is ~6x the observed max —
          // real margin for a contended host while still catching a genuine hang.
          {
            command: "CI=true pnpm install --frozen-lockfile --store-dir /home/agent/.pnpm-store",
            timeoutMs: 300_000,
          },
          // The pre-push language gate (#198): point git at the tracked hook dir
          // so every worker's push runs the pinned Go seam stages over any Go
          // change before it lands — a lint/build/test defect becomes a
          // worker-visible push failure instead of a red main. The hook self-skips
          // outside the sandbox (FACTORY_SANDBOX, set by the Dockerfile), so a
          // host push is never gated. Relative path resolves from the worktree
          // root; guarded so a config hiccup can't abort the sandbox.
          { command: "git config core.hooksPath .sandcastle/git-hooks || true" },
          // Credential-free origin (#195): `origin` inside the sandbox carries NO
          // token (the org-wide FORGEJO_TOKEN no longer rides in its URL — where it
          // persisted in the shared .git/config every worker bind-mounts). Wire
          // git-cred-lib.sh's token-free credential helper into this worktree so a
          // worker's manual `git push origin` and land-pr.sh authenticate with no
          // token on disk or argv: the helper is a POINTER to the secret (a
          // `cat /run/secrets/forgejo_token` deferred to git-invocation time), never
          // the secret. The empty first value resets any inherited helper so only
          // ours runs; useHttpPath=false scopes the credential to the host. Must
          // stay byte-identical to git-cred-lib.sh's GIT_CRED_HELPER. Guarded so a
          // config hiccup can't abort the sandbox.
          {
            command:
              "git config --replace-all credential.helper '' " +
              "&& git config --add credential.helper " +
              "'!f(){ [ \"$1\" = get ] || exit 0; t=\"${FORGEJO_TOKEN:-}\"; for p in \"${SWARM_TOKEN_FILE:-}\" \"${SWARM_SANDBOX_TOKEN_FILE:-/run/secrets/forgejo_token}\"; do [ -n \"$p\" ] && [ -r \"$p\" ] && { t=\"$(cat \"$p\")\"; break; }; done; printf \"username=swarm\\npassword=%s\\n\" \"$t\"; }; f' " +
              "&& git config credential.useHttpPath false || true",
          },
        ],
      },
    },

    // #612: cancels the whole run (all remaining iterations) when the TUI's
    // Cancel action writes this run's marker file. See ADR 0186 for the full
    // design — including why a hard, immediate mid-iteration kill is accepted
    // rather than deferred, and why that is provably safe against
    // close-report.sh's own comment-then-close ordering.
    signal: cancelController.signal,
  });
} catch (err) {
  if (cancelTimer) clearInterval(cancelTimer);
  driveMirrorStop();
  if (cancelController.signal.aborted) {
    // #612: a deliberate operator stop, not a crash. Sandcastle's `signal`
    // contract gives no partial RunResult back on abort ("no
    // Sandcastle-specific wrapping") — so, unlike the success path below,
    // nothing here can feed record-run-result.sh; any iteration that fully
    // succeeded before the cancel landed keeps its real Forgejo close but
    // loses its swarm.db mirror row (ADR 0186 §2, a named/accepted gap: the
    // db is a MIRROR, losing it loses nothing authoritative).
    //
    // This line mirrors close-report.sh's SANDCASTLE_ATTEMPT convention — a
    // structured protocol line for run-swarm.sh's swarm_cancel_hit to grep
    // (cancel-lib.sh), never worker chain-of-thought prose.
    console.log(`SANDCASTLE_CANCELLED run=${swarmDbRunId ?? "unknown"} reason=${cancelReason ?? ""}`);
    process.exit(1);
  }
  throw err;
}
if (cancelTimer) clearInterval(cancelTimer);
driveMirrorStop();

// #574: RunResult capture — this used to be discarded entirely, leaving
// swarm.db's attempts/spend tables with zero production writers (schema +
// tests existed; only the offline test suite ever called the writers).
// record-run-result.sh (host-side, same process posture as this script — it
// shells out to python3 directly, same as swarm-db-lib.sh) does the actual
// parsing/writing: it pairs close-report.sh's SANDCASTLE_ATTEMPT marker lines
// (parsed out of the combined stdout) against `result.iterations` in order,
// since IterationResult carries no issue number of its own.
//
// SWARM_DB_RUN_ID is exported by run-swarm.sh as the SAME run_db_id every
// other swarm-db write in that script uses — main.mts runs on the host as a
// direct child of run-swarm.sh, so it is already in this process's env, no
// docker-forwarding needed. Absent (a bare `pnpm run sandcastle`, outside
// run-swarm.sh) means skip: this is a best-effort MIRROR, exactly like every
// other swarm-db write in the codebase, so a write we cannot make — or
// correctly attribute to a run — must never fail this otherwise-successful
// run.
if (swarmDbRunId) {
  try {
    const payload = JSON.stringify({
      stdout: result.stdout,
      logFilePath: result.logFilePath ?? null,
      iterations: result.iterations.map((it) => ({
        sessionId: it.sessionId ?? null,
        sessionFilePath: it.sessionFilePath ?? null,
        usage: it.usage ?? null,
      })),
    });
    const scriptPath = fileURLToPath(new URL("./record-run-result.sh", import.meta.url));
    execFileSync("bash", [scriptPath, swarmDbRunId], {
      input: payload,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err) {
    console.log(`worker: record-run-result.sh failed (swarm.db mirror only, non-fatal): ${err}`);
  }
} else {
  console.log("worker: SWARM_DB_RUN_ID not set (a manual run outside run-swarm.sh?) — skipping the swarm.db mirror");
}
