<template>
  <div class="link-scan-screen h-full flex flex-col bg-background">
    <OnboardingHeader
      title="Sign in with your computer"
      subtitle="Scan the code shown on your computer to sign in here"
      :show-back-button="true"
      @back="onBack"
    />

    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-md mx-auto space-y-6">
        <!-- Step 1: scan / paste -->
        <template v-if="phase === 'input'">
          <div class="notice-box bg-primary/10 border border-primary/20 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <QrCode class="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium mb-1">Scan the code on your computer</h4>
                <p class="text-sm text-muted-foreground">
                  On your computer, choose “Sign in with your phone” to show a code, then scan it here.
                </p>
              </div>
            </div>
          </div>

          <div>
            <label class="block text-xs text-muted-foreground mb-1" for="device-name">
              This device's name
            </label>
            <input
              id="device-name"
              v-model="deviceName"
              type="text"
              class="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              maxlength="40"
              autocomplete="off"
            />
            <p class="text-xs text-muted-foreground mt-1">
              Shown on your computer so you can confirm it's really you.
            </p>
          </div>

          <MBtn
            v-if="scannerAvailable"
            class="w-full h-12 text-base rounded-xl"
            @click="onScan"
          >
            <Camera class="w-4 h-4 mr-2" />
            Scan the code
          </MBtn>

          <!-- Paste fallback (emulators, e2e, dev, and any device that can't scan) -->
          <div class="paste-box bg-card border border-border rounded-xl p-4 space-y-2">
            <label class="block text-sm font-medium" for="paste-code">
              Can't scan? Paste the code
            </label>
            <input
              id="paste-code"
              v-model="pastedPayload"
              type="text"
              class="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="matou://pair?…"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
            <MBtn
              variant="outline"
              class="w-full h-10 rounded-lg"
              :disabled="!pastedPayload.trim()"
              @click="onPaste"
            >
              Continue
            </MBtn>
          </div>

          <div v-if="errorMessage" class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-4">
            <div class="flex items-center gap-3">
              <XCircle class="w-5 h-5 text-destructive shrink-0" />
              <p class="text-sm text-destructive">{{ errorMessage }}</p>
            </div>
          </div>
        </template>

        <!-- Connecting -->
        <template v-else-if="phase === 'connecting'">
          <div class="flex flex-col items-center gap-4 py-10 text-center">
            <div class="w-14 h-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            <p class="text-sm text-muted-foreground">Connecting to your computer…</p>
          </div>
        </template>

        <!-- Fresh phone: waiting for approval on the other device -->
        <template v-else-if="phase === 'waiting'">
          <div class="text-center space-y-4">
            <p class="text-sm text-muted-foreground">
              Check that your computer shows this code, then approve there:
            </p>
            <div class="code-display" data-testid="sas-code">{{ code }}</div>
            <div class="flex items-center justify-center gap-2 text-muted-foreground">
              <div class="w-4 h-4 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
              <p class="text-sm">Waiting for approval on your other device…</p>
            </div>
          </div>
          <MBtn variant="outline" class="w-full h-11 rounded-xl" @click="onCancel">
            Cancel
          </MBtn>
        </template>

        <!-- Holder phone: approve the sign-in on the other device -->
        <template v-else-if="phase === 'approve'">
          <div class="text-center space-y-3">
            <h4 class="text-base font-semibold">
              Sign in on {{ peerDeviceName || 'your computer' }}?
            </h4>
            <p class="text-sm text-muted-foreground">
              Only approve if that device shows this code:
            </p>
            <div class="code-display" data-testid="sas-code">{{ code }}</div>
          </div>
          <div class="flex gap-3">
            <MBtn variant="outline" class="flex-1 h-11 rounded-xl" @click="onCancel">
              Cancel
            </MBtn>
            <MBtn class="flex-1 h-11 rounded-xl" data-testid="approve" @click="onApprove">
              Approve
            </MBtn>
          </div>
        </template>

        <!-- Holder phone: sending / linked -->
        <template v-else-if="phase === 'sending'">
          <div class="flex flex-col items-center gap-4 py-10 text-center">
            <div class="w-14 h-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            <p class="text-sm text-muted-foreground">Signing you in on {{ peerDeviceName || 'the other device' }}…</p>
          </div>
        </template>

        <template v-else-if="phase === 'linked'">
          <div class="success-box bg-accent/10 border border-accent/30 rounded-xl p-6 text-center space-y-3">
            <CheckCircle2 class="w-10 h-10 text-accent mx-auto" />
            <h4 class="text-base font-semibold text-accent">Linked</h4>
            <p class="text-sm text-muted-foreground">
              {{ peerDeviceName || 'Your other device' }} is now signed in with your identity.
            </p>
          </div>
          <MBtn class="w-full h-11 rounded-xl" @click="onBack">Done</MBtn>
        </template>

        <!-- Fresh phone: receiving the identity -->
        <template v-else-if="phase === 'receiving'">
          <div class="flex flex-col items-center gap-4 py-10 text-center">
            <div class="w-14 h-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            <p class="text-sm text-muted-foreground">Setting up your identity on this device…</p>
          </div>
        </template>

        <!-- neither / already-linked / conflict -->
        <template v-else-if="phase === 'blocked'">
          <div class="notice-box bg-primary/10 border border-primary/20 rounded-xl p-5 text-center space-y-2">
            <Info class="w-8 h-8 text-primary mx-auto" />
            <h4 class="text-base font-semibold">{{ blockedTitle }}</h4>
            <p class="text-sm text-muted-foreground">{{ blockedMessage }}</p>
          </div>
          <MBtn variant="outline" class="w-full h-11 rounded-xl" @click="reset">Try again</MBtn>
        </template>

        <!-- pairing ended / timed out -->
        <template v-else-if="phase === 'ended'">
          <div class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-5 text-center space-y-2">
            <XCircle class="w-8 h-8 text-destructive mx-auto" />
            <h4 class="text-base font-semibold">Sign-in didn't finish</h4>
            <p class="text-sm text-muted-foreground">{{ errorMessage || 'The pairing ended on the other device or timed out.' }}</p>
          </div>
          <MBtn variant="outline" class="w-full h-11 rounded-xl" @click="reset">Try again</MBtn>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { QrCode, Camera, XCircle, CheckCircle2, Info } from 'lucide-vue-next';
import OnboardingHeader from './OnboardingHeader.vue';
import MBtn from '../base/MBtn.vue';
import { usePairing, PairingError, type PairingState, type SessionStatus } from 'src/composables/usePairing';
import { useRecoverIdentity } from 'src/composables/useRecoverIdentity';
import { isScannerAvailable, scanPairingQr, ScanUnavailableError } from 'src/lib/barcode';
import { getCapacitorPlatform } from 'src/lib/capacitor';
import { KIT } from 'src/generated/kit';

type Phase =
  | 'input'
  | 'connecting'
  | 'waiting'
  | 'approve'
  | 'sending'
  | 'linked'
  | 'receiving'
  | 'blocked'
  | 'ended';

const pairing = usePairing();
const { recoverIdentity } = useRecoverIdentity();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const phase = ref<Phase>('input');
const deviceName = ref(defaultDeviceName());
const pastedPayload = ref('');
const errorMessage = ref('');
const code = ref('');
const peerDeviceName = ref('');
const blockedTitle = ref('');
const blockedMessage = ref('');
const scannerAvailable = isScannerAvailable();

let sessionId = '';
/**
 * Generation of the current handshake. Every cancel / reset / back / unmount
 * bumps it, and every step that resumes after an `await` checks it, so a poll
 * response (or the identity fetch + recovery that follows it) that lands after
 * the user has left the flow can never act on stale state.
 */
let generation = 0;

function defaultDeviceName(): string {
  const platform = getCapacitorPlatform();
  if (platform === 'ios') return 'My iPhone';
  return 'My phone';
}

const POLL_INTERVAL_MS = 1500;
const TERMINAL: readonly PairingState[] = ['cancelled', 'expired', 'failed'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cheap client-side shape check before anything is POSTed: the backend parses
 * and verifies the payload (`internal/pairing/qr.go`), but a random string
 * pasted into the field should get a plain "that's not a sign-in code" here
 * rather than a round-trip and a protocol error message.
 */
function isPairingPayload(text: string): boolean {
  if (!text.startsWith('matou://pair?')) return false;
  const params = new URLSearchParams(text.slice('matou://pair?'.length));
  return !!(params.get('id') && params.get('pk') && params.get('s'));
}

const NOT_A_CODE = "That doesn't look like a sign-in code. Copy the whole “matou://pair?…” text from your computer.";

async function onScan() {
  errorMessage.value = '';
  try {
    const payload = await scanPairingQr();
    if (!payload) return; // user dismissed the scanner
    if (!isPairingPayload(payload)) {
      errorMessage.value = NOT_A_CODE;
      return;
    }
    await startHandshake(payload);
  } catch (err) {
    if (err instanceof ScanUnavailableError) {
      errorMessage.value =
        err.reason === 'permission-denied'
          ? 'Camera access is off. Allow it in Settings, or paste the code instead.'
          : "This device can't scan. Paste the code instead.";
    } else {
      errorMessage.value = 'Could not start the scanner. Paste the code instead.';
    }
  }
}

async function onPaste() {
  const payload = pastedPayload.value.trim();
  if (!payload) return;
  if (!isPairingPayload(payload)) {
    errorMessage.value = NOT_A_CODE;
    return;
  }
  await startHandshake(payload);
}

async function startHandshake(qrPayload: string) {
  errorMessage.value = '';
  phase.value = 'connecting';
  const gen = ++generation;
  try {
    const result = await pairing.scan(qrPayload, deviceName.value.trim() || defaultDeviceName());
    if (gen !== generation) {
      // The user backed out while the hello/ack round-trip was in flight; the
      // session it created is not ours any more — tear it down and stay put.
      cancelQuietly(result.sessionId);
      return;
    }
    sessionId = result.sessionId;
    code.value = result.code ?? '';
    peerDeviceName.value = result.peerDeviceName ?? '';

    switch (result.outcome) {
      case 'desktop-to-phone':
        phase.value = 'waiting';
        void waitForIdentity();
        break;
      case 'phone-to-desktop':
        phase.value = 'approve';
        break;
      case 'neither':
        showBlocked('Nothing to sign in with', 'Neither device has an identity yet. Create or recover one first.');
        break;
      case 'already-linked':
        showBlocked('Already linked', 'These devices are already signed in with the same identity.');
        break;
      case 'conflict':
        showBlocked(
          'Different identities',
          "These devices hold different identities. Linking never overwrites an existing identity — to use this one here, sign out on this device first.",
        );
        break;
      default:
        showEnded();
    }
  } catch (err) {
    if (gen !== generation) return;
    handleScanError(err);
  }
}

function handleScanError(err: unknown) {
  phase.value = 'input';
  if (err instanceof PairingError) {
    if (err.code === 'config-server-mismatch') {
      errorMessage.value = `That code is from a different ${KIT.brand.name} environment and can't be used here.`;
      return;
    }
    if (err.code === 'identity-present') {
      errorMessage.value = 'This device already has an identity. Sign out first to use a different one.';
      return;
    }
    errorMessage.value = err.message || 'That code could not be used. Try again.';
    return;
  }
  errorMessage.value = 'Could not reach the backend. Please try again.';
}

/** Fresh phone: poll until the identity has arrived, then recover it locally. */
async function waitForIdentity() {
  const gen = generation;
  const status = await pollUntil(gen, (s) => s.state === 'identity-received' || s.state === 'done');
  if (!status) return; // terminal / cancelled / left — pollUntil already routed us
  phase.value = 'receiving';
  try {
    const identity = await pairing.fetchIdentity(sessionId);
    if (gen !== generation) return;
    const result = await recoverIdentity(identity.mnemonic, {
      mode: 'link',
      ...(identity.adminAid ? { adminAid: identity.adminAid } : {}),
      ...(identity.orgAid ? { orgAid: identity.orgAid } : {}),
    });
    if (gen !== generation) return;
    if (!result.success) {
      showEnded(result.error || 'Could not finish signing in on this device.');
      return;
    }
    // Recovered — hand off to the welcome overlay for backend setup + checks.
    emit('continue');
  } catch (err) {
    if (gen !== generation) return;
    errorMessage.value =
      err instanceof PairingError && err.code === 'identity-present'
        ? 'This device already has an identity. Sign out first to use a different one.'
        : err instanceof Error
          ? err.message
          : 'Could not finish signing in on this device.';
    showEnded(errorMessage.value);
  }
}

/** Holder phone: approve, then wait for the receiver to confirm. */
async function onApprove() {
  phase.value = 'sending';
  const gen = generation;
  try {
    await pairing.approve(sessionId);
  } catch (err) {
    if (gen !== generation) return;
    showEnded(err instanceof Error ? err.message : undefined);
    return;
  }
  if (gen !== generation) return;
  const status = await pollUntil(gen, (s) => s.state === 'done');
  if (!status) return;
  if (status.error) {
    showEnded(status.error);
  } else {
    phase.value = 'linked';
  }
}

/**
 * Poll session status until `predicate` holds (returns the status), or a
 * terminal state routes the screen to "ended" (returns null). Returns null
 * without touching the screen as soon as `gen` is no longer the current
 * generation (cancel / reset / back / unmount) — including when the response
 * that was already in flight at that moment finally lands.
 */
async function pollUntil(
  gen: number,
  predicate: (s: SessionStatus) => boolean,
): Promise<SessionStatus | null> {
  const id = sessionId;
  while (gen === generation) {
    let status: SessionStatus;
    try {
      status = await pairing.getStatus(id);
    } catch (err) {
      if (gen !== generation) return null;
      // A 404/410 (unknown or expired) means the pairing is gone.
      if (err instanceof PairingError && (err.status === 404 || err.status === 410)) {
        showEnded();
        return null;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (gen !== generation) return null;
    if (predicate(status)) {
      return status;
    }
    if (TERMINAL.includes(status.state)) {
      showEnded();
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function showBlocked(title: string, message: string) {
  blockedTitle.value = title;
  blockedMessage.value = message;
  phase.value = 'blocked';
}

function showEnded(message?: string) {
  errorMessage.value = message ?? '';
  phase.value = 'ended';
}

/** Best-effort backend teardown: a failed cancel is not the user's problem —
 *  the far side's next long-poll 404s and the session expires anyway. */
function cancelQuietly(id: string) {
  pairing.cancel(id).catch(() => {
    /* best-effort */
  });
}

function onCancel() {
  const id = sessionId;
  reset();
  if (id) cancelQuietly(id);
}

function reset() {
  generation++;
  sessionId = '';
  code.value = '';
  peerDeviceName.value = '';
  errorMessage.value = '';
  pastedPayload.value = '';
  phase.value = 'input';
}

function onBack() {
  const id = sessionId;
  reset();
  if (id) cancelQuietly(id);
  emit('back');
}

onUnmounted(() => {
  // Stop any poll loop and make every in-flight continuation a no-op. The
  // session itself is left to the backend's TTL: after a successful receipt
  // the backend still has to send `done`, so an unconditional cancel here
  // would race it.
  generation++;
  sessionId = '';
  code.value = '';
  peerDeviceName.value = '';
});
</script>

<style lang="scss" scoped>
.link-scan-screen {
  background-color: var(--matou-background);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.paste-box {
  background-color: var(--matou-card);
}

.error-box {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.success-box {
  background-color: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.3);
}

.code-display {
  font-family: monospace;
  font-size: 2.25rem;
  font-weight: 700;
  letter-spacing: 0.35rem;
  color: var(--matou-foreground);
}
</style>
