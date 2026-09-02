import { useOnboardingStore } from 'stores/onboarding';
import { requestPermissionAndRegister } from 'src/composables/usePush';

/**
 * Onboarding completion seam.
 *
 * The kit rewrite (#242) moved screen navigation into
 * src/kit/onboarding-flow.ts + OnboardingPage's handlers, so the old
 * navigation maps that lived here are gone. What remains is the completion
 * contract: reaching 'main' is the ONE moment push permission may be
 * requested — never during onboarding (docs/architecture/
 * 08-push-notifications.md §7, proven by tests/scripts/push.test.ts).
 * OnboardingPage's 'main' watcher fires the same hook for store-driven
 * completions; requestPermissionAndRegister is idempotent and a no-op off
 * Android, so the double fire is harmless (same as before the rewrite).
 */
export function useOnboarding() {
  const store = useOnboardingStore();

  const completeOnboarding = () => {
    store.navigateTo('main');
    void requestPermissionAndRegister();
  };

  return { completeOnboarding };
}
