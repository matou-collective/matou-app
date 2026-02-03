<template>
  <div class="welcome-overlay h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div class="flex flex-col items-center gap-8 max-w-md w-full">
      <!-- Logo -->
      <div class="logo-container backdrop-blur-sm rounded-3xl">
        <img
          src="../../assets/images/matou-logo.svg"
          alt="Matou Logo"
          class="w-[200px] h-[112px]"
        />
      </div>

      <!-- Welcome Message -->
      <div class="text-center space-y-3">
        <h1 class="text-3xl md:text-4xl font-bold text-white">
          Welcome to Matou
        </h1>
        <p v-if="displayName" class="text-xl text-white/90">
          {{ displayName }}
        </p>
        <p class="text-white/70 text-base md:text-lg mt-2">
          {{ subtitle }}
        </p>
      </div>

      <!-- Status Summary -->
      <div class="w-full space-y-3">
        <div
          v-for="check in checks"
          :key="check.id"
          class="status-item flex items-center gap-3 bg-white/10 rounded-xl px-4 py-3"
        >
          <!-- Passed -->
          <CheckCircle2
            v-if="check.status === 'passed'"
            class="w-5 h-5 text-emerald-300 shrink-0"
          />
          <!-- Checking -->
          <Loader2
            v-else-if="check.status === 'checking'"
            class="w-5 h-5 text-white/70 shrink-0 animate-spin"
          />
          <!-- Failed -->
          <XCircle
            v-else-if="check.status === 'failed'"
            class="w-5 h-5 text-red-300 shrink-0"
          />
          <!-- Pending -->
          <Circle
            v-else
            class="w-5 h-5 text-white/30 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <span class="text-white/90 text-sm">{{ check.label }}</span>
            <p v-if="check.status === 'failed' && check.error" class="text-red-300 text-xs mt-0.5">
              {{ check.error }}
            </p>
          </div>
        </div>
      </div>

      <!-- Continue Button -->
      <MBtn
        class="w-full continue-btn"
        size="lg"
        :disabled="!allChecksPassed"
        @click="handleContinue"
      >
        Continue to Dashboard
        <ArrowRight class="w-5 h-5 ml-2" />
      </MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { CheckCircle2, XCircle, Circle, ArrowRight, Loader2 } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { useAppStore } from 'stores/app';
import { useKERIClient } from 'src/lib/keri/client';
import { setBackendIdentity } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

const emit = defineEmits<{
  (e: 'continue'): void;
}>();

const onboardingStore = useOnboardingStore();
const identityStore = useIdentityStore();
const appStore = useAppStore();
const keriClient = useKERIClient();
const displayName = computed(() => onboardingStore.profile.name || '');

type CheckStatus = 'pending' | 'checking' | 'passed' | 'failed';

interface StatusCheck {
  id: string;
  label: string;
  status: CheckStatus;
  error: string | null;
}

const isRecoveryFlow = computed(() => onboardingStore.onboardingPath === 'recover');

const subtitle = computed(() => {
  if (!isRecoveryFlow.value) {
    return 'Your identity has been claimed, your community spaces are ready, and your profiles have been created.';
  }
  if (allChecksPassed.value) {
    return 'All checks passed. You are ready to continue.';
  }
  if (checks.some(c => c.status === 'failed')) {
    return 'Some checks failed. Please review the issues below.';
  }
  return 'Verifying your membership and community access...';
});

const checks = reactive<StatusCheck[]>([
  { id: 'identity', label: 'Identity recovered', status: 'pending', error: null },
  { id: 'backend', label: 'Backend identity configured', status: 'pending', error: null },
  { id: 'community', label: 'Community space access', status: 'pending', error: null },
  { id: 'credential', label: 'Membership credential', status: 'pending', error: null },
]);

const allChecksPassed = computed(() => checks.every(c => c.status === 'passed'));

function findCheck(id: string): StatusCheck {
  return checks.find(c => c.id === id)!;
}

async function runRecoveryChecks() {
  // Check 1: Identity recovered — already true (we're on this screen)
  const identityCheck = findCheck('identity');
  identityCheck.status = 'checking';
  await sleep(300);
  if (identityStore.hasIdentity && identityStore.currentAID) {
    identityCheck.status = 'passed';
  } else {
    identityCheck.status = 'failed';
    identityCheck.error = 'No identity found in session';
    return;
  }

  // Check 2: Backend identity configured
  const backendCheck = findCheck('backend');
  backendCheck.status = 'checking';
  try {
    const aid = identityStore.currentAID!.prefix;
    const mnemonic = await secureStorage.getItem('matou_mnemonic');
    if (!mnemonic) {
      backendCheck.status = 'failed';
      backendCheck.error = 'No mnemonic found — cannot configure backend';
      return;
    }
    const result = await setBackendIdentity({
      aid,
      mnemonic,
      orgAid: appStore.orgAid ?? undefined,
      communitySpaceId: appStore.orgConfig?.communitySpaceId ?? undefined,
      readOnlySpaceId: appStore.orgConfig?.readOnlySpaceId ?? undefined,
      adminSpaceId: appStore.orgConfig?.adminSpaceId ?? undefined,
    });
    if (result.success) {
      backendCheck.status = 'passed';
    } else {
      backendCheck.status = 'failed';
      backendCheck.error = result.error || 'Backend identity setup failed';
      return;
    }
  } catch (err) {
    backendCheck.status = 'failed';
    backendCheck.error = 'Failed to reach backend';
    return;
  }

  // Check 3: Community space access
  // The backend may need time after identity setup to derive keys and sync spaces,
  // so retry with backoff.
  const communityCheck = findCheck('community');
  communityCheck.status = 'checking';
  try {
    let hasAccess = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(2000);
      await identityStore.fetchUserSpaces();
      hasAccess = await identityStore.verifyCommunityAccess();
      if (hasAccess) break;
    }
    if (hasAccess) {
      communityCheck.status = 'passed';
    } else {
      communityCheck.status = 'failed';
      communityCheck.error = 'No community space found — your backend may need reconfiguration';
      return;
    }
  } catch {
    communityCheck.status = 'failed';
    communityCheck.error = 'Failed to verify community access';
    return;
  }

  // Check 4: Membership credential in KERI wallet
  // The agent may need time to sync credentials after reconnection, so retry.
  const credentialCheck = findCheck('credential');
  credentialCheck.status = 'checking';
  try {
    const client = keriClient.getSignifyClient();
    if (!client) {
      credentialCheck.status = 'failed';
      credentialCheck.error = 'KERI client not connected';
      return;
    }
    let found = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(2000);
      const credentials = await client.credentials().list();
      console.log(`[WelcomeOverlay] Credential check attempt ${attempt + 1}: ${credentials.length} credentials`);
      if (credentials.length > 0) {
        found = true;
        break;
      }
    }
    if (found) {
      credentialCheck.status = 'passed';
    } else {
      credentialCheck.status = 'failed';
      credentialCheck.error = 'No membership credential in wallet';
    }
  } catch (err) {
    console.error('[WelcomeOverlay] Credential check error:', err);
    credentialCheck.status = 'failed';
    credentialCheck.error = 'Failed to check credentials';
  }
}

function markAllPassed() {
  for (const check of checks) {
    check.status = 'passed';
  }
}

function handleContinue() {
  emit('continue');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

onMounted(() => {
  if (isRecoveryFlow.value) {
    runRecoveryChecks();
  } else {
    // Claim flow: everything was verified during claim processing
    markAllPassed();
  }
});
</script>

<style lang="scss" scoped>
.welcome-overlay {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.9) 50%,
    var(--matou-accent) 100%
  );
  min-height: 100vh;
}

.logo-container {
  img {
    object-fit: contain;
    line-height: 0;
  }
}

.continue-btn {
  background-color: #ffffff !important;
  color: var(--matou-primary) !important;
  height: 3.5rem !important;
  border-radius: var(--matou-radius-2xl) !important;

  &:hover:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
