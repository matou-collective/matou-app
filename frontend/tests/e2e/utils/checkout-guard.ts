/**
 * Guard against two concurrent e2e runs on one machine stomping each other.
 *
 * Two Playwright runs from different checkouts (or git worktrees) share the
 * same fixed ports — the admin backend on 9080 and the test dev server on
 * 9003 — plus the fixed backend log at /tmp/matou-test-backend.log. When the
 * second run kills/rebinds 9080 or reuses a 9003 dev server built from the
 * *other* checkout's sources, the first run silently corrupts (issue #175:
 * org config vanished mid-test, or a blank page from a shared Vite dep cache).
 *
 * These helpers detect when a fixed port is held by a process whose working
 * directory lives under a *different* repo checkout and fail fast with an
 * actionable error, instead of stomping it. This does NOT make concurrent runs
 * coexist — it only turns a silent corruption into a loud, explanatory failure.
 *
 * Detection is best-effort and Linux-only (reads /proc/<pid>/cwd). On platforms
 * without /proc (macOS), or when the cwd cannot be resolved, the guard stays
 * silent so a normal single-run e2e is never blocked by a false positive.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Absolute repo root of THIS checkout (parent of frontend/ and backend/). */
export function thisRepoRoot(): string {
  // __dirname = <repo>/frontend/tests/e2e/utils
  return path.resolve(__dirname, '..', '..', '..', '..');
}

/** PIDs listening on a TCP port (empty if none, or if lsof is unavailable). */
export function listeningPids(port: number): number[] {
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, {
      encoding: 'utf-8',
    }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Resolved working directory of a process, or null if not discoverable. */
export function pidCwd(pid: number): string | null {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
}

/**
 * Decide whether a resolved process cwd belongs to a different checkout than
 * this repo root. Pure and side-effect free so it is unit-testable.
 *
 * - null cwd (undiscoverable / non-Linux) -> not foreign (stay silent).
 * - cwd equal to, or nested under, repoRoot -> not foreign (same checkout).
 * - anything else -> foreign.
 */
export function isForeignCheckout(cwd: string | null, repoRoot: string): boolean {
  if (!cwd) return false;
  const root = repoRoot.replace(/[/\\]+$/, '');
  return cwd !== root && !cwd.startsWith(root + path.sep);
}

/**
 * Assert that no process from a *different* checkout is holding `port`.
 * Throws an actionable error naming the port and the conflicting checkout when
 * a foreign owner is detected; returns quietly otherwise.
 */
export function assertPortOwnedByThisCheckout(
  port: number,
  label: string,
  repoRoot: string = thisRepoRoot(),
): void {
  for (const pid of listeningPids(port)) {
    const cwd = pidCwd(pid);
    if (isForeignCheckout(cwd, repoRoot)) {
      throw new Error(
        [
          `E2E port collision on ${port} (${label}).`,
          `A process (pid ${pid}) from a DIFFERENT checkout is holding it:`,
          `  foreign cwd:   ${cwd}`,
          `  this checkout: ${repoRoot}`,
          '',
          'Another e2e run is already active on this machine. Run only ONE e2e',
          'run per machine. If you are using git worktrees, `npm ci` inside the',
          'worktree instead of symlinking node_modules, and stop the other run',
          `before starting this one (its backend/dev-server holds port ${port}).`,
        ].join('\n'),
      );
    }
  }
}

/**
 * Guard both fixed e2e ports before a run touches them: the admin backend on
 * 9080 and the test dev server on 9003. Call from test preflight so a second
 * run fails fast instead of stomping the first.
 */
export function assertLocalCheckoutOwnsE2EPorts(): void {
  assertPortOwnedByThisCheckout(9080, 'admin backend');
  assertPortOwnedByThisCheckout(9003, 'test dev server');
}
