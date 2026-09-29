/**
 * Admits the credentials a member's community issues them after they joined
 * (issue #685), on the shared KERIA notification poll. Accepts silently, then
 * tells the member once the credential is in their wallet.
 *
 * Mounted by the dashboard layout, so it runs on every signed-in page. The
 * rules — whose grants are admitted, and in what order — live in
 * `src/lib/keri/grantAdmission`.
 */
import { watch } from 'vue';
import { Notify } from 'quasar';
import { useRouter } from 'vue-router';
import { useIdentityStore } from 'stores/identity';
import { useWalletStore } from 'stores/wallet';
import { maybeNotify } from 'src/lib/notifications';
import { createLogger } from 'src/lib/logging';
import { admitPendingCommunityGrants } from 'src/lib/keri/communityGrants';
import { admittedMessage, type AdmittedCredential, type GrantNote } from 'src/lib/keri/grantAdmission';
import { useKERINotificationService } from './useKERINotificationService';

const log = createLogger('GrantAdmission');

export function useGrantAdmission() {
  const identityStore = useIdentityStore();
  const walletStore = useWalletStore();
  const notificationService = useKERINotificationService();
  const router = useRouter();

  // One run at a time: the poll can deliver the same unread grant again while
  // an admit is still on the wire.
  let running = false;

  function tell(admitted: AdmittedCredential): void {
    const message = admittedMessage(admitted);
    maybeNotify({ title: message, body: 'It is in your wallet.', data: { route: 'wallet' } });
    Notify.create({
      message,
      caption: 'It is in your wallet.',
      position: 'top-right',
      timeout: 8000,
      color: 'primary',
      actions: [
        { label: 'View', color: 'white', handler: () => void router.push({ name: 'wallet' }) },
        { label: 'Dismiss', color: 'white' },
      ],
    });
  }

  async function run(notes: readonly GrantNote[]): Promise<void> {
    if (running) return;
    running = true;
    try {
      const landed = await admitPendingCommunityGrants(identityStore.currentAID?.prefix, notes);
      if (landed.length === 0) return;
      await walletStore.loadCredentials();
      landed.forEach(tell);
      void notificationService.triggerNow();
    } catch (err) {
      log.warn('grant admission failed; the next poll tries again', err);
    } finally {
      running = false;
    }
  }

  const stop = watch(
    notificationService.notifications,
    (notes) => void run(notes as unknown as GrantNote[]),
    { immediate: true },
  );

  return { stop };
}
