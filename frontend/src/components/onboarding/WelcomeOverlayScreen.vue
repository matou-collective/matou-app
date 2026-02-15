<template>
  <div class="welcome-overlay h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div class="flex flex-col items-center gap-6 max-w-md w-full">
      <!-- Success state: Logo + Text Logo + Rotating Welcome -->
      <template v-if="allChecksPassed">
        <!-- M Logo -->
        <div class="logo-container">
          <img
            src="../../assets/images/matou-logo.svg"
            alt="Matou Logo"
            class="w-[250px] h-[140px]"
          />
        </div>

        <!-- Text Logo -->
        <div class="text-center">
          <img
            src="../../assets/images/matou-text-logo-white.svg"
            alt="Matou"
            class="w-[300px] h-[100px] mx-auto"
          />
        </div>

        <!-- Rotating Indigenous Welcome -->
        <p class="text-white/80 text-base md:text-lg mt-4 mb-6">
          <span class="welcome-word" :class="{ 'fade-out': wordFading }">{{ currentWelcome.word }}</span>, {{ displayName }}!
        </p>
      </template>

      <!-- Checking state: Simple logo + status checks -->
      <template v-else>
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
      </template>

      <!-- Continue Button -->
      <MBtn
        class="w-full continue-btn"
        size="lg"
        :disabled="!allChecksPassed"
        @click="handleContinue"
      >
        {{ allChecksPassed ? 'Enter Community' : 'Verifying...' }}
        <ArrowRight class="w-5 h-5 ml-2" />
      </MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
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
  (e: 'needs-approval'): void;
}>();

const onboardingStore = useOnboardingStore();
const identityStore = useIdentityStore();
const appStore = useAppStore();
const keriClient = useKERIClient();

// Display name: prefer AID name, then profile name, then truncated AID
const displayName = computed(() => {
  if (onboardingStore.profile.name) return onboardingStore.profile.name;
  const aid = identityStore.currentAID;
  if (aid?.name) return aid.name;
  const prefix = aid?.prefix ?? '';
  if (prefix.length > 20) return `${prefix.slice(0, 10)}...${prefix.slice(-6)}`;
  return prefix || 'Member';
});

// Welcome words in indigenous languages
const welcomeWords = [
  { word: 'Nau mai', language: 'Māori' },
  { word: 'E komo mai', language: 'Hawaiian' },
  { word: "Yá'át'ééh", language: 'Navajo' },
  { word: 'Osiyo', language: 'Cherokee' },
  { word: 'Taŋyáŋ yahí', language: 'Lakota' },
  { word: 'Hamuykuy', language: 'Quechua' },
  { word: 'Ximopanolti', language: 'Nahuatl' },
  { word: 'Tunngasugit', language: 'Inuktitut' },
  { word: 'Tereg̃uahẽ porãite', language: 'Guaraní' },
  { word: 'Mari mari', language: 'Mapudungun' },
];

const welcomeIndex = ref(0);
const currentWelcome = computed(() => welcomeWords[welcomeIndex.value]);
const wordFading = ref(false);
let welcomeTimer: ReturnType<typeof setInterval> | null = null;

function startWelcomeRotation() {
  stopWelcomeRotation();
  welcomeIndex.value = 0;
  welcomeTimer = setInterval(() => {
    wordFading.value = true;
    setTimeout(() => {
      welcomeIndex.value = (welcomeIndex.value + 1) % welcomeWords.length;
      wordFading.value = false;
    }, 400);
  }, 3000);
}

function stopWelcomeRotation() {
  if (welcomeTimer) {
    clearInterval(welcomeTimer);
    welcomeTimer = null;
  }
}

type CheckStatus = 'pending' | 'checking' | 'passed' | 'failed';

interface StatusCheck {
  id: string;
  label: string;
  status: CheckStatus;
  error: string | null;
}

const isRecoveryFlow = computed(() => onboardingStore.onboardingPath === 'recover');
const isReturningFlow = computed(() => onboardingStore.onboardingPath === 'returning');

const subtitle = computed(() => {
  if (!isRecoveryFlow.value && !isReturningFlow.value) {
    return 'Your identity has been claimed, your community spaces are ready, and your profiles have been created.';
  }
  if (allChecksPassed.value) {
    return 'All checks passed. You are ready to continue.';
  }
  if (checks.some(c => c.status === 'failed')) {
    return 'Some checks failed. Please review the issues below.';
  }
  if (isReturningFlow.value) {
    return 'Verifying your membership status...';
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

async function runReturningChecks() {
  // Check 1: Identity — already restored
  const identityCheck = findCheck('identity');
  identityCheck.status = 'checking';
  await sleep(200);
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
      backendCheck.error = 'No mnemonic found';
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
  } catch {
    backendCheck.status = 'failed';
    backendCheck.error = 'Failed to reach backend';
    return;
  }

  // Check 3: Membership credential — this determines if we continue or redirect
  const credentialCheck = findCheck('credential');
  credentialCheck.status = 'checking';
  try {
    const client = keriClient.getSignifyClient();
    if (!client) {
      // No KERI client — redirect to pending approval
      console.log('[WelcomeOverlay] No KERI client, redirecting to pending-approval');
      emit('needs-approval');
      return;
    }
    const credentials = await client.credentials().list();
    console.log(`[WelcomeOverlay] Returning user credential check: ${credentials.length} credentials`);
    if (credentials.length > 0) {
      credentialCheck.status = 'passed';
    } else {
      // No credential — redirect to pending approval
      console.log('[WelcomeOverlay] No credential found, redirecting to pending-approval');
      emit('needs-approval');
      return;
    }
  } catch (err) {
    console.error('[WelcomeOverlay] Credential check error:', err);
    // On error, redirect to pending approval to poll
    emit('needs-approval');
    return;
  }

  // Check 4: Community space access
  const communityCheck = findCheck('community');
  communityCheck.status = 'checking';
  try {
    await identityStore.fetchUserSpaces();
    const hasAccess = await identityStore.verifyCommunityAccess();
    if (hasAccess) {
      communityCheck.status = 'passed';
    } else {
      communityCheck.status = 'failed';
      communityCheck.error = 'No community space access';
    }
  } catch {
    communityCheck.status = 'failed';
    communityCheck.error = 'Failed to verify community access';
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

// Start welcome rotation when all checks pass
watch(allChecksPassed, (passed) => {
  if (passed) {
    startWelcomeRotation();
  }
});

onMounted(() => {
  if (isRecoveryFlow.value) {
    runRecoveryChecks();
  } else if (isReturningFlow.value) {
    // Returning flow: Splash already verified credential exists, skip checks
    markAllPassed();
    startWelcomeRotation();
  } else {
    // Claim flow: everything was verified during claim processing
    markAllPassed();
    startWelcomeRotation();
  }
});

onUnmounted(() => {
  stopWelcomeRotation();
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

.welcome-word {
  display: inline-block;
  transition: opacity 0.4s ease;
}

.welcome-word.fade-out {
  opacity: 0;
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
