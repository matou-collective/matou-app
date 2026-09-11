<template>
  <div class="link-qr-screen h-full flex flex-col bg-background">
    <OnboardingHeader
      title="Sign in with your phone"
      subtitle="Link this computer to your existing Matou identity"
      :show-back-button="true"
      @back="onBack"
    />

    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-md mx-auto space-y-6">
        <!-- Error creating the session -->
        <div
          v-if="phase === 'error'"
          class="state-card bg-destructive/10 border border-destructive/30 rounded-xl p-6 text-center"
        >
          <XCircle class="w-10 h-10 text-destructive mx-auto mb-3" />
          <h3 class="text-base font-semibold mb-1">Couldn't start pairing</h3>
          <p class="text-sm text-muted-foreground mb-4">{{ errorMessage }}</p>
          <MBtn class="w-full h-11 rounded-xl" @click="start">Try again</MBtn>
        </div>

        <!-- QR + waiting for the phone to scan -->
        <template v-else-if="phase === 'waiting'">
          <div class="qr-card bg-card border border-border rounded-xl p-6 flex flex-col items-center text-center">
            <div v-if="qrDataUrl" class="qr-frame bg-white rounded-lg p-3">
              <img :src="qrDataUrl" alt="Pairing QR code" class="w-56 h-56" data-testid="pairing-qr" />
            </div>
            <div v-else class="w-56 h-56 flex items-center justify-center">
              <div class="w-10 h-10 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            </div>
            <h3 class="text-base font-semibold mt-5">Scan this with the Matou app on your phone</h3>
            <p class="text-sm text-muted-foreground mt-1">
              Open Matou on your phone and choose "Sign in with your computer".
            </p>
            <p v-if="countdown" class="text-xs text-muted-foreground mt-3">
              This code expires in {{ countdown }}
            </p>
          </div>
          <p class="text-xs text-muted-foreground text-center">
            Your recovery phrase never appears in this code — it travels encrypted only after you approve.
          </p>
        </template>

        <!-- Fresh desktop, phone holds: show code, wait for approval on the phone -->
        <div
          v-else-if="phase === 'awaiting-approval'"
          class="state-card bg-card border border-border rounded-xl p-6 text-center"
        >
          <Smartphone class="w-10 h-10 text-primary mx-auto mb-3" />
          <h3 class="text-base font-semibold mb-1">Waiting for approval on your phone</h3>
          <p class="text-sm text-muted-foreground mb-4">
            Check that your phone shows the same code, then approve there.
          </p>
          <div class="code-display" data-testid="pairing-code">{{ code }}</div>
          <MBtn variant="outline" class="w-full h-11 rounded-xl mt-6" @click="onBack">Cancel</MBtn>
        </div>

        <!-- Holder desktop, phone fresh: confirm the code, Approve / Cancel -->
        <div
          v-else-if="phase === 'approve'"
          class="state-card bg-card border border-border rounded-xl p-6 text-center"
        >
          <ShieldCheck class="w-10 h-10 text-primary mx-auto mb-3" />
          <h3 class="text-base font-semibold mb-1">Sign in on {{ peerDeviceName || 'your phone' }}?</h3>
          <p class="text-sm text-muted-foreground mb-4">
            Only approve if the phone shows this same code:
          </p>
          <div class="code-display" data-testid="pairing-code">{{ code }}</div>
          <div class="flex gap-3 mt-6">
            <MBtn variant="outline" class="flex-1 h-11 rounded-xl" :disabled="busy" @click="onBack">Cancel</MBtn>
            <MBtn class="flex-1 h-11 rounded-xl" :disabled="busy" @click="onApprove">Approve</MBtn>
          </div>
        </div>

        <!-- Holder desktop after Approve: the identity is on its way; the phone
             has not confirmed yet (spec §2 message 4 — done{ok,error}) -->
        <div
          v-else-if="phase === 'sending'"
          class="state-card bg-card border border-border rounded-xl p-6 text-center"
        >
          <div class="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin mx-auto mb-4" />
          <h3 class="text-base font-semibold mb-1">Sending your identity to {{ peerDeviceName || 'your phone' }}…</h3>
          <p class="text-sm text-muted-foreground">Keep this window open until your phone finishes signing in.</p>
        </div>

        <!-- Holder desktop once the phone confirmed (done{ok:true}) -->
        <div
          v-else-if="phase === 'sent'"
          class="state-card bg-accent/10 border border-accent/30 rounded-xl p-6 text-center"
        >
          <CheckCircle2 class="w-10 h-10 text-accent mx-auto mb-3" />
          <h3 class="text-base font-semibold mb-1">Linked</h3>
          <p class="text-sm text-muted-foreground mb-4">
            Your phone now has your identity. You can keep using Matou on this computer.
          </p>
          <MBtn class="w-full h-11 rounded-xl" @click="onBack">Done</MBtn>
        </div>

        <!-- Fresh desktop receiving the identity, then running recovery -->
        <div
          v-else-if="phase === 'receiving'"
          class="state-card bg-card border border-border rounded-xl p-6 text-center"
        >
          <div class="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin mx-auto mb-4" />
          <h3 class="text-base font-semibold mb-1">Signing you in…</h3>
          <p class="text-sm text-muted-foreground">Restoring your identity on this computer.</p>
        </div>

        <!-- Neither / already-linked / conflict / ended -->
        <div
          v-else-if="phase === 'message'"
          class="state-card bg-card border border-border rounded-xl p-6 text-center"
        >
          <AlertCircle class="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <h3 class="text-base font-semibold mb-1">{{ messageTitle }}</h3>
          <p class="text-sm text-muted-foreground mb-4">{{ messageBody }}</p>
          <MBtn class="w-full h-11 rounded-xl" @click="start">Start over</MBtn>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import QRCode from 'qrcode';
import {
  XCircle,
  CheckCircle2,
  AlertCircle,
  Smartphone,
  ShieldCheck,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useOnboardingStore } from 'stores/onboarding';
import {
  usePairing,
  PairingError,
  type PairingOutcome,
  type SessionStatus,
} from 'src/composables/usePairing';
import { useRecoverIdentity } from 'src/composables/useRecoverIdentity';

type Phase =
  | 'loading'
  | 'waiting'
  | 'awaiting-approval'
  | 'approve'
  | 'sending'
  | 'sent'
  | 'receiving'
  | 'message'
  | 'error';

/** Status poll cadence. The backend also pushes `pairing:state` over SSE, but
 *  the QR screen is reached before the app has an identity/SSE session, so it
 *  polls. */
const POLL_INTERVAL_MS = 1500;

const ENDED_TITLE = 'Pairing ended';
const ENDED_BODY = 'The pairing ended on the other device or timed out. Start over to try again.';

const onboardingStore = useOnboardingStore();
const pairing = usePairing();
const { recoverIdentity } = useRecoverIdentity();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const phase = ref<Phase>('loading');
const sessionId = ref<string | null>(null);
const qrDataUrl = ref<string | null>(null);
const code = ref('');
const peerDeviceName = ref('');
const errorMessage = ref('');
const messageTitle = ref('');
const messageBody = ref('');
const busy = ref(false);
const expiresAt = ref<number | null>(null);
const now = ref(Date.now());

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
/** Set once the screen is leaving; every in-flight poll bails out. */
let stopped = false;
/** Set once the backend session is over (done / continued / cancelled) so the
 *  teardown on back/unmount does not fire a pointless cancel. */
let finished = false;

const countdown = computed(() => {
  if (!expiresAt.value) return '';
  const secs = Math.max(0, Math.round((expiresAt.value - now.value) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
});

/** The name the phone shows in "Sign in on ‹device name›?". */
function deviceName(): string {
  const platform = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  const os =
    platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : '';
  return os ? `${os} computer` : 'Computer';
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function showMessage(title: string, body: string) {
  messageTitle.value = title;
  messageBody.value = body;
  phase.value = 'message';
  stopPolling();
}

/** User-facing copy for a failed pairing request. Never echoes a payload. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof PairingError) {
    if (err.code === 'identity-present') {
      return (
        'This computer already has an identity' +
        (err.aid ? ` (${err.aid})` : '') +
        '. Linking never replaces it — sign out first to use a different identity here.'
      );
    }
    if (err.code === 'config-server-mismatch') {
      return 'Your phone is set up for a different Matou server than this computer. Both devices must use the same server.';
    }
    if (err.status === 410) return 'This code expired before your phone finished. Start over to show a new one.';
    if (err.status === 404) {
      return 'This pairing session is no longer available (the app may have restarted). Start over to show a new code.';
    }
    return err.message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Map a terminal / refusal outcome or state to the user-facing message. */
function handleTerminal(status: SessionStatus): boolean {
  const outcome = status.outcome as PairingOutcome;
  if (outcome === 'neither') {
    finished = true;
    showMessage(
      'Neither device has an identity yet',
      'Create or recover an identity on one of your devices first, then try linking again.',
    );
    return true;
  }
  if (outcome === 'already-linked') {
    finished = true;
    showMessage('These devices are already linked', 'Your phone and this computer already share the same identity.');
    return true;
  }
  if (outcome === 'conflict') {
    finished = true;
    showMessage(
      'These devices hold different identities',
      'Linking never replaces an identity that is already here. To use a different identity on this computer, sign out first.',
    );
    return true;
  }
  if (status.state === 'expired' || status.state === 'cancelled') {
    finished = true;
    showMessage(ENDED_TITLE, ENDED_BODY);
    return true;
  }
  if (status.state === 'failed') {
    finished = true;
    showMessage('Pairing failed', status.error || 'Something went wrong during pairing. Start over to try again.');
    return true;
  }
  return false;
}

async function poll() {
  const id = sessionId.value;
  if (stopped || !id) return;
  let status: SessionStatus;
  try {
    status = await pairing.getStatus(id);
  } catch (err) {
    // A poll that outlived its session (back / start over) must not touch the
    // screen; otherwise a 404/410 means the backend dropped the session.
    if (stopped || sessionId.value !== id) return;
    finished = true;
    showMessage(ENDED_TITLE, describeError(err, ENDED_BODY));
    return;
  }
  if (stopped || sessionId.value !== id) return;

  if (handleTerminal(status)) return;

  if (status.outcome === 'phone-to-desktop') {
    // This desktop is fresh; the phone holds. Show the code and wait for the
    // holder (phone) to approve, then receive the identity.
    code.value = status.code;
    peerDeviceName.value = status.peerDeviceName;
    if (status.state === 'identity-received' || status.state === 'done') {
      await receiveIdentity();
      return;
    }
    if (phase.value !== 'receiving') phase.value = 'awaiting-approval';
  } else if (status.outcome === 'desktop-to-phone') {
    // This desktop holds; the phone is fresh. Confirm the code and approve.
    code.value = status.code;
    peerDeviceName.value = status.peerDeviceName;
    if (status.state === 'done') {
      // The phone's done{ok,error} landed: ok → Linked, otherwise its error.
      stopPolling();
      finished = true;
      if (status.error) {
        showMessage('Sign-in failed on your phone', status.error);
      } else {
        phase.value = 'sent';
      }
      return;
    }
    if (status.state === 'approved' || status.state === 'identity-sent') {
      phase.value = 'sending';
    } else if (phase.value !== 'sending') {
      phase.value = 'approve';
    }
  }

  pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
}

async function receiveIdentity() {
  if (!sessionId.value) return;
  phase.value = 'receiving';
  stopPolling();
  try {
    const identity = await pairing.fetchIdentity(sessionId.value);
    const result = await recoverIdentity(identity.mnemonic, {
      mode: 'link',
      adminAid: identity.adminAid,
      orgAid: identity.orgAid,
    });
    if (!result.success) {
      finished = true;
      showMessage('Sign-in failed', result.error || 'Could not restore your identity on this computer.');
      return;
    }
    // The receiving device is now indistinguishable from a recovered one:
    // welcome-overlay runs the backend identity setup in link mode → dashboard.
    finished = true;
    onboardingStore.setPath('link');
    emit('continue');
  } catch (err) {
    finished = true;
    showMessage('Sign-in failed', describeError(err, 'Could not restore your identity on this computer.'));
  }
}

async function onApprove() {
  if (!sessionId.value || busy.value) return;
  busy.value = true;
  try {
    await pairing.approve(sessionId.value);
    // Approve is idempotent on the backend, but the button must go away: the
    // state moves approved → identity-sent → done (or failed) from here.
    phase.value = 'sending';
    if (!pollTimer) pollTimer = setTimeout(() => void poll(), 800);
  } catch (err) {
    errorMessage.value = describeError(err, 'Approval failed');
    phase.value = 'error';
  } finally {
    busy.value = false;
  }
}

async function start() {
  stopPolling();
  finished = false;
  phase.value = 'loading';
  sessionId.value = null;
  qrDataUrl.value = null;
  code.value = '';
  peerDeviceName.value = '';
  errorMessage.value = '';
  try {
    const session = await pairing.createSession(deviceName());
    if (stopped) return;
    sessionId.value = session.sessionId;
    expiresAt.value = Date.parse(session.expiresAt) || null;
    qrDataUrl.value = await QRCode.toDataURL(session.qrPayload, { margin: 1, width: 256 });
    phase.value = 'waiting';
    pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  } catch (err) {
    errorMessage.value = describeError(err, 'Could not reach the backend to start pairing.');
    phase.value = 'error';
  }
}

/** Best-effort backend teardown; skipped once the session is already over. */
function cancelSession() {
  const id = sessionId.value;
  if (!id || finished) return;
  finished = true;
  pairing.cancel(id).catch(() => {
    // Best-effort teardown.
  });
}

function onBack() {
  stopped = true;
  stopPolling();
  cancelSession();
  emit('back');
}

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  void start();
});

onUnmounted(() => {
  stopped = true;
  stopPolling();
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  // Leaving the screen any other way (route change, app reload) must not
  // leave a live QR session on the backend.
  cancelSession();
});
</script>

<style lang="scss" scoped>
.link-qr-screen {
  background-color: var(--matou-background);
}

.qr-card,
.state-card {
  background-color: var(--matou-card);
}

.qr-frame {
  background-color: #ffffff;
}

.code-display {
  font-family: var(--font-mono, monospace);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.35rem;
  color: var(--matou-foreground);
}
</style>
