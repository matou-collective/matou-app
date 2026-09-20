import { describe, expect, it } from 'vitest';
import { canRetryFailedChecks } from 'src/lib/welcomeRetry';

const check = (status: 'pending' | 'checking' | 'passed' | 'failed') => ({ status });

describe('canRetryFailedChecks (#570)', () => {
  it('offers Retry when a check has failed outright on a sign-in flow', () => {
    // A red "Backend identity configured" used to leave only a disabled
    // "Verifying..." button: the way out was force-closing the app.
    for (const flow of ['link', 'recover', 'returning'] as const) {
      expect(canRetryFailedChecks(flow, false, [check('passed'), check('failed'), check('pending')])).toBe(true);
    }
  });

  it('does not offer it while checks are still running', () => {
    expect(canRetryFailedChecks('link', false, [check('failed'), check('checking')])).toBe(false);
    expect(canRetryFailedChecks('link', false, [check('passed'), check('checking')])).toBe(false);
  });

  it('does not offer it when nothing failed', () => {
    expect(canRetryFailedChecks('link', false, [check('passed'), check('passed')])).toBe(false);
  });

  it('leaves the waiting-for-sync state to its own Retry button', () => {
    expect(canRetryFailedChecks('link', true, [check('failed')])).toBe(false);
  });

  it('does not offer it on the register and claim flows, whose checks cannot be re-run', () => {
    expect(canRetryFailedChecks('register', false, [check('failed')])).toBe(false);
    expect(canRetryFailedChecks('claim', false, [check('failed')])).toBe(false);
    expect(canRetryFailedChecks(null, false, [check('failed')])).toBe(false);
  });
});
