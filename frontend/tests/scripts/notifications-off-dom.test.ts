/**
 * Regression for the flaky vitest failure in #489.
 *
 * `maybeNotify` fires from an event-stream callback (useBackendEvents), so it
 * can run after — or outside — the DOM environment that scheduled it. This file
 * runs under the default `node` environment (no `// @vitest-environment` line),
 * where `document` is undefined, mirroring the off-DOM case where a leaked async
 * task surfaces. Before the guard, the bare `document.visibilityState` read threw
 * an unhandled `ReferenceError: document is not defined` that failed the whole
 * suite with every test still passing.
 */
import { describe, it, expect } from 'vitest';
import { maybeNotify } from 'src/lib/notifications';

describe('maybeNotify off-DOM', () => {
  it('is a no-op instead of throwing when document is undefined', () => {
    expect(typeof document).toBe('undefined');
    expect(() => maybeNotify({ title: 'x', body: 'y' })).not.toThrow();
  });
});
