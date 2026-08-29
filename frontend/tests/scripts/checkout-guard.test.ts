import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isForeignCheckout } from '../e2e/utils/checkout-guard';

/**
 * Unit coverage for the pure classification used by the e2e port-collision
 * guard (issue #175). The lsof / /proc plumbing is Linux- and live-process
 * specific and is exercised only in a real e2e run; here we lock down the
 * decision that turns a resolved cwd into "foreign checkout: yes/no".
 */
describe('isForeignCheckout', () => {
  const repoRoot = '/home/dev/matou-app';

  it('treats an undiscoverable cwd (null) as NOT foreign — stay silent', () => {
    // macOS / no /proc / permission denied -> never a false positive.
    expect(isForeignCheckout(null, repoRoot)).toBe(false);
  });

  it('treats the repo root itself as NOT foreign', () => {
    expect(isForeignCheckout(repoRoot, repoRoot)).toBe(false);
  });

  it('treats a nested dir of this checkout (backend/frontend) as NOT foreign', () => {
    expect(isForeignCheckout(path.join(repoRoot, 'backend'), repoRoot)).toBe(false);
    expect(isForeignCheckout(path.join(repoRoot, 'frontend'), repoRoot)).toBe(false);
  });

  it('treats a different checkout as foreign', () => {
    expect(isForeignCheckout('/home/dev/matou-app-2/backend', repoRoot)).toBe(true);
    expect(isForeignCheckout('/home/dev/worktrees/feature-x/backend', repoRoot)).toBe(true);
  });

  it('is not fooled by a sibling whose path shares a prefix string', () => {
    // "/home/dev/matou-app-2" starts with "/home/dev/matou-app" as a raw string
    // but is a different checkout — the path-separator boundary check must catch it.
    expect(isForeignCheckout('/home/dev/matou-app-2', repoRoot)).toBe(true);
  });

  it('tolerates a trailing slash on the repo root', () => {
    expect(isForeignCheckout(path.join(repoRoot, 'backend'), repoRoot + '/')).toBe(false);
    expect(isForeignCheckout('/home/dev/other/backend', repoRoot + '/')).toBe(true);
  });
});
