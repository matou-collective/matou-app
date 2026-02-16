<template>
  <div class="mnemonic-verification-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      title="Verify Your Recovery Phrase"
      subtitle="Enter the requested words to confirm you've saved your phrase"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Info Notice -->
        <div class="notice-box bg-primary/10 border border-primary/20 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <Shield class="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-medium mb-1">Why verify?</h4>
              <p class="text-sm text-muted-foreground">
                This step ensures you've correctly saved your recovery phrase.
                Without it, you won't be able to recover your identity if you lose access to this device.
              </p>
            </div>
          </div>
        </div>

        <!-- Verification Inputs -->
        <div class="verification-card bg-card border border-border rounded-xl p-6">
          <h3 class="text-sm font-medium mb-4">Enter the following words from your recovery phrase:</h3>

          <div class="space-y-4">
            <div
              v-for="(wordIndex, i) in verificationIndices"
              :key="i"
              class="word-input-group"
            >
              <label :for="`word-${i}`" class="block text-sm font-medium mb-2">
                Word #{{ wordIndex + 1 }}
              </label>
              <div class="relative">
                <input
                  :id="`word-${i}`"
                  v-model="userInputs[i]"
                  type="text"
                  class="w-full px-4 py-3 bg-background border rounded-lg text-base font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
                  :class="{
                    'border-border': !errors[i] && !correct[i],
                    'border-destructive bg-destructive/5': errors[i],
                    'border-accent bg-accent/5': correct[i],
                  }"
                  :placeholder="`Enter word #${wordIndex + 1}`"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  @input="clearError(i)"
                  @keyup.enter="handleVerify"
                />
                <div class="absolute right-3 top-1/2 -translate-y-1/2">
                  <CheckCircle2 v-if="correct[i]" class="w-5 h-5 text-accent" />
                  <XCircle v-else-if="errors[i]" class="w-5 h-5 text-destructive" />
                </div>
              </div>
              <p v-if="errors[i]" class="text-xs text-destructive mt-1">
                Incorrect word. Please check your recovery phrase.
              </p>
            </div>
          </div>
        </div>

        <!-- Attempt Counter -->
        <div v-if="attempts > 0" class="text-center">
          <p class="text-sm text-muted-foreground">
            Attempt {{ attempts }} of 3
          </p>
        </div>

        <!-- Too Many Attempts Warning -->
        <div
          v-if="attempts >= 3"
          class="warning-box bg-amber-500/10 border border-amber-500/30 rounded-xl p-4"
        >
          <div class="flex items-start gap-3">
            <AlertTriangle class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-semibold text-amber-600 mb-1">
                Having trouble?
              </h4>
              <p class="text-sm text-muted-foreground mb-3">
                You've made 3 incorrect attempts. Would you like to go back and view your recovery phrase again?
              </p>
              <button
                type="button"
                class="text-sm text-primary hover:underline font-medium"
                @click="handleShowPhraseAgain"
              >
                Show recovery phrase again
              </button>
            </div>
          </div>
        </div>

        <!-- Error Display -->
        <div
          v-if="verificationError"
          class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-4"
        >
          <div class="flex items-center gap-3">
            <XCircle class="w-5 h-5 text-destructive shrink-0" />
            <p class="text-sm text-destructive">{{ verificationError }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
      <div class="max-w-2xl mx-auto">
        <MBtn
          class="w-full h-12 text-base rounded-xl"
          :disabled="!canVerify || isSubmitting"
          @click="handleVerify"
        >
          <template v-if="isSubmitting">
            <Loader2 class="w-4 h-4 mr-2 animate-spin" />
            Submitting Registration...
          </template>
          <template v-else>
            Verify and Continue
            <ArrowRight class="w-4 h-4 ml-2" />
          </template>
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          Make sure you've saved your recovery phrase before continuing
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useOnboardingStore } from 'stores/onboarding';
import { useRegistration } from 'composables/useRegistration';

const store = useOnboardingStore();
const { isSubmitting, error: registrationError, submitRegistration } = useRegistration();

const userInputs = ref<string[]>(['', '', '']);
const errors = ref<boolean[]>([false, false, false]);
const correct = ref<boolean[]>([false, false, false]);
const verificationError = ref('');

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
  (e: 'show-phrase-again'): void;
}>();

// Get mnemonic data from store
const mnemonic = computed(() => store.mnemonic.words);
const verificationIndices = computed(() => store.mnemonic.verificationIndices);
const attempts = computed(() => store.mnemonic.attempts);

// Check if all fields are filled
const canVerify = computed(() => {
  return userInputs.value.every(input => input.trim().length > 0);
});

// Initialize verification indices if not set
onMounted(() => {
  if (verificationIndices.value.length === 0 && mnemonic.value.length > 0) {
    // Generate random indices if not already set
    store.resetMnemonicVerification();
  }
});

function clearError(index: number) {
  errors.value[index] = false;
  correct.value[index] = false;
  verificationError.value = '';
}

async function handleVerify() {
  if (!canVerify.value || isSubmitting.value) return;

  verificationError.value = '';
  let allCorrect = true;

  // Check each word
  verificationIndices.value.forEach((wordIndex, i) => {
    const userWord = userInputs.value[i].trim().toLowerCase();
    const correctWord = mnemonic.value[wordIndex]?.toLowerCase();

    if (userWord === correctWord) {
      correct.value[i] = true;
      errors.value[i] = false;
    } else {
      correct.value[i] = false;
      errors.value[i] = true;
      allCorrect = false;
    }
  });

  if (allCorrect) {
    // Mnemonic verified! Now send registration to org
    store.recordVerificationAttempt(true);

    // Only send registration for the 'register' path (not invite or setup paths)
    // Setup path = admin already has credential issued, invite path = already invited
    if (store.onboardingPath === 'register') {
      console.log('[MnemonicVerification] Sending registration to org...');
      console.log('[MnemonicVerification] Profile data:', {
        name: store.profile.name,
        avatarFileRef: store.profile.avatarFileRef,
        hasAvatar: !!store.profile.avatarFileRef,
      });

      const success = await submitRegistration({
        name: store.profile.name,
        email: store.profile.email || undefined,
        bio: store.profile.bio,
        location: store.profile.location || undefined,
        joinReason: store.profile.joinReason || undefined,
        indigenousCommunity: store.profile.indigenousCommunity || undefined,
        facebookUrl: store.profile.facebookUrl || undefined,
        linkedinUrl: store.profile.linkedinUrl || undefined,
        twitterUrl: store.profile.twitterUrl || undefined,
        instagramUrl: store.profile.instagramUrl || undefined,
        githubUrl: store.profile.githubUrl || undefined,
        gitlabUrl: store.profile.gitlabUrl || undefined,
        interests: store.profile.participationInterests,
        customInterests: store.profile.customInterests,
        avatarFileRef: store.profile.avatarFileRef || undefined,
        avatarData: store.profile.avatarData || undefined,
        avatarMimeType: store.profile.avatarMimeType || undefined,
      });

      if (!success) {
        verificationError.value = registrationError.value || 'Failed to submit registration. Please try again.';
        return;
      }

      console.log('[MnemonicVerification] Registration sent successfully');
    }

    emit('continue');
  } else {
    // Record failed attempt
    store.recordVerificationAttempt(false);

    if (attempts.value >= 3) {
      verificationError.value = 'Please review your recovery phrase and try again.';
    } else {
      verificationError.value = 'Some words are incorrect. Please check and try again.';
    }
  }
}

function handleShowPhraseAgain() {
  emit('show-phrase-again');
}

function onBack() {
  emit('back');
}
</script>

<style lang="scss" scoped>
.mnemonic-verification-screen {
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

.verification-card {
  background-color: var(--matou-card);
}

.warning-box {
  background-color: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.error-box {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.word-input-group {
  input {
    &:focus {
      outline: none;
    }
  }
}
</style>
