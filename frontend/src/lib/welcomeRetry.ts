/**
 * Whether the welcome screen should offer a Retry button because a check
 * failed outright (as opposed to the retryable "waiting for sync" state, which
 * has its own Retry and auto-retry).
 *
 * Only the sign-in flows can re-run their checks from the top; the register
 * and claim flows do their work before the screen and have nothing to repeat.
 */
export type WelcomeFlow = 'link' | 'recover' | 'returning' | 'register' | 'claim' | string | null | undefined;

export function canRetryFailedChecks(
  flow: WelcomeFlow,
  waitingForSync: boolean,
  checks: ReadonlyArray<{ status: string }>,
): boolean {
  if (flow !== 'link' && flow !== 'recover' && flow !== 'returning') return false;
  if (waitingForSync) return false;
  if (checks.some(c => c.status === 'checking')) return false;
  return checks.some(c => c.status === 'failed');
}
