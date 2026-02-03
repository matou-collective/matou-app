<template>
  <div class="recovery-screen h-full flex flex-col bg-background">
    <!-- Loading Overlay -->
    <Transition name="fade">
      <div
        v-if="isRecovering"
        class="loading-overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-6 max-w-sm text-center p-8">
          <div class="relative">
            <div class="w-20 h-20 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            <KeyRound class="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <div>
            <h2 class="text-lg font-semibold mb-2">{{ loadingMessage }}</h2>
            <p class="text-sm text-muted-foreground">{{ loadingSubtext }}</p>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <button
        class="mb-4 text-muted-foreground hover:text-foreground transition-colors"
        @click="onBack"
      >
        <ArrowLeft class="w-5 h-5" />
      </button>
      <h1 class="mb-2">Recover Your Identity</h1>
      <p class="text-muted-foreground">Enter your 12-word recovery phrase to restore access</p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Info Notice -->
        <div class="notice-box bg-primary/10 border border-primary/20 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <Shield class="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-medium mb-1">Secure Recovery</h4>
              <p class="text-sm text-muted-foreground">
                Your recovery phrase is used to derive your cryptographic keys locally.
                It is never sent to any server.
              </p>
            </div>
          </div>
        </div>

        <!-- Mnemonic Input -->
        <div class="mnemonic-input-card bg-card border border-border rounded-xl p-6">
          <h3 class="text-sm font-medium mb-4">Enter your 12-word recovery phrase</h3>

          <div class="grid grid-cols-3 gap-3">
            <div
              v-for="(_, index) in 12"
              :key="index"
              class="word-input-group"
            >
              <label :for="`word-${index}`" class="block text-xs text-muted-foreground mb-1">
                {{ index + 1 }}.
              </label>
              <input
                :id="`word-${index}`"
                v-model="words[index]"
                type="text"
                class="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
                :class="{
                  'border-border': !hasError,
                  'border-destructive bg-destructive/5': hasError,
                }"
                placeholder="word"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                @input="clearError"
                @paste="handlePaste($event, index)"
              />
            </div>
          </div>

          <!-- Paste hint -->
          <p class="text-xs text-muted-foreground mt-3">
            Tip: You can paste your entire phrase into the first field
          </p>
        </div>

        <!-- Error Display -->
        <div
          v-if="errorMessage"
          class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-4"
        >
          <div class="flex items-center gap-3">
            <XCircle class="w-5 h-5 text-destructive shrink-0" />
            <p class="text-sm text-destructive">{{ errorMessage }}</p>
          </div>
        </div>

        <!-- Success Display -->
        <div
          v-if="recoveredAID"
          class="success-box bg-accent/10 border border-accent/30 rounded-xl p-4"
        >
          <div class="flex items-start gap-3">
            <CheckCircle2 class="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-semibold text-accent mb-1">Identity Recovered!</h4>
              <p class="text-sm text-muted-foreground mb-2">
                Found your identity: <span class="font-medium">{{ recoveredName }}</span>
              </p>
              <p class="text-xs font-mono text-muted-foreground break-all">
                {{ recoveredAID }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
      <div class="max-w-2xl mx-auto">
        <MBtn
          v-if="!recoveredAID"
          class="w-full h-12 text-base rounded-xl"
          :disabled="!canRecover"
          @click="handleRecover"
        >
          Recover Identity
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
        <MBtn
          v-else
          class="w-full h-12 text-base rounded-xl"
          @click="handleContinue"
        >
          Continue to Dashboard
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          Don't have an account? <button class="text-primary hover:underline" @click="onBack">Go back</button>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  Shield,
  KeyRound,
  XCircle,
  CheckCircle2,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { KERIClient } from 'src/lib/keri/client';
import { secureStorage } from 'src/lib/secureStorage';

const identityStore = useIdentityStore();

const words = ref<string[]>(Array(12).fill(''));
const isRecovering = ref(false);
const loadingMessage = ref('');
const loadingSubtext = ref('');
const errorMessage = ref('');
const hasError = ref(false);
const recoveredAID = ref<string | null>(null);
const recoveredName = ref<string | null>(null);

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const canRecover = computed(() => {
  return words.value.every(word => word.trim().length > 0) && !isRecovering.value;
});

function clearError() {
  errorMessage.value = '';
  hasError.value = false;
}

function handlePaste(event: ClipboardEvent, index: number) {
  const pastedText = event.clipboardData?.getData('text') || '';
  const pastedWords = pastedText.trim().split(/\s+/);

  // If pasting multiple words, fill them in starting from the current index
  if (pastedWords.length > 1) {
    event.preventDefault();
    for (let i = 0; i < pastedWords.length && index + i < 12; i++) {
      words.value[index + i] = pastedWords[i].toLowerCase();
    }
  }
}

async function handleRecover() {
  clearError();
  isRecovering.value = true;

  try {
    // Step 1: Validate mnemonic
    loadingMessage.value = 'Validating recovery phrase...';
    loadingSubtext.value = 'Checking phrase format';
    await sleep(300);

    const mnemonic = words.value.map(w => w.trim().toLowerCase()).join(' ');

    if (!KERIClient.validateMnemonic(mnemonic)) {
      throw new Error('Invalid recovery phrase. Please check your words and try again.');
    }

    // Step 2: Derive passcode from mnemonic
    loadingMessage.value = 'Deriving keys...';
    loadingSubtext.value = 'Generating cryptographic keys from your phrase';
    await sleep(300);

    const passcode = KERIClient.passcodeFromMnemonic(mnemonic);

    // Step 3: Connect to KERIA
    loadingMessage.value = 'Connecting to identity network...';
    loadingSubtext.value = 'Looking for your identity';

    const connected = await identityStore.connect(passcode);

    if (!connected) {
      throw new Error(identityStore.error || 'Failed to connect. This phrase may not have an identity yet.');
    }

    // Step 4: Check if we found an identity
    if (identityStore.hasIdentity && identityStore.currentAID) {
      recoveredAID.value = identityStore.currentAID.prefix;
      recoveredName.value = identityStore.currentAID.name;
      loadingMessage.value = 'Identity recovered!';
      loadingSubtext.value = '';
    } else {
      throw new Error('No identity found for this recovery phrase. It may be a new phrase.');
    }

  } catch (err) {
    console.error('[Recovery] Failed:', err);
    errorMessage.value = err instanceof Error ? err.message : 'Recovery failed. Please try again.';
    hasError.value = true;
  } finally {
    isRecovering.value = false;
  }
}

async function handleContinue() {
  // Store mnemonic for backend identity setup (welcome overlay needs it)
  const mnemonic = words.value.map(w => w.trim().toLowerCase()).join(' ');
  await secureStorage.setItem('matou_mnemonic', mnemonic);
  // Also store in onboarding store for display name
  const onboardingStore = useOnboardingStore();
  onboardingStore.updateProfile({ name: recoveredName.value || '' });
  emit('continue');
}

function onBack() {
  emit('back');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
</script>

<style lang="scss" scoped>
.recovery-screen {
  background-color: var(--matou-background);
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.mnemonic-input-card {
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

.word-input-group {
  input {
    &:focus {
      outline: none;
    }
  }
}

// Loading overlay
.loading-overlay {
  h2 {
    color: var(--matou-foreground);
  }
}

// Transitions
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
