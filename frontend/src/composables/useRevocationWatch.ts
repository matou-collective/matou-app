/**
 * Tells the member when their community revokes a credential of theirs (issue
 * #687), and keeps the wallet's cards true while the app is open.
 *
 * Mounted by the dashboard layout, so it runs on every signed-in page: a look
 * when the app opens, then one a minute. The Wallet page and the sign-in card
 * read standing for themselves whenever they load; what any look reveals is
 * told here, once per credential. The rules live in
 * `src/lib/keri/credentialStanding`.
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { Notify } from 'quasar';
import { useRouter } from 'vue-router';
import { useIdentityStore } from 'stores/identity';
import { useWalletStore } from 'stores/wallet';
import { maybeNotify } from 'src/lib/notifications';
import {
  lookForRevocations,
  revealedRevocations,
  toldOnThisDevice,
} from 'src/lib/keri/communityStanding';
import {
  revokedMessage,
  takeUntold,
  type RevokedCredential,
} from 'src/lib/keri/credentialStanding';

/** How often an open app looks. */
const LOOK_INTERVAL_MS = 60_000;

export function useRevocationWatch() {
  const identityStore = useIdentityStore();
  const walletStore = useWalletStore();
  const router = useRouter();

  let timer: ReturnType<typeof setInterval> | null = null;
  // One look at a time: a slow agent must not stack looks behind it.
  let looking = false;

  function tell(revoked: RevokedCredential): void {
    const message = revokedMessage(revoked);
    maybeNotify({ title: message, body: 'It can no longer be used to sign in.', data: { route: 'wallet' } });
    Notify.create({
      message,
      caption: 'It can no longer be used to sign in.',
      position: 'top-right',
      timeout: 8000,
      color: 'warning',
      actions: [
        { label: 'View', color: 'white', handler: () => void router.push({ name: 'wallet' }) },
        { label: 'Dismiss', color: 'white' },
      ],
    });
  }

  async function look(): Promise<void> {
    if (looking) return;
    looking = true;
    try {
      await lookForRevocations(identityStore.currentAID?.prefix);
    } finally {
      looking = false;
    }
  }

  const stop = watch(
    revealedRevocations,
    (revealed) => {
      const untold = takeUntold(revealed, toldOnThisDevice);
      if (untold.length === 0) return;
      // The cards the wallet already drew still say Active.
      void walletStore.loadCredentials();
      untold.forEach(tell);
    },
    { immediate: true },
  );

  onMounted(() => {
    void look();
    timer = setInterval(() => void look(), LOOK_INTERVAL_MS);
  });

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  return { stop, look };
}
