<template>
  <div class="claim-processing-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <h1 class="mb-2">Claiming Your Identity</h1>
      <p class="text-muted-foreground">
        Securing your identity with new cryptographic keys
      </p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Progress Steps -->
        <div class="steps-container bg-card border border-border rounded-xl p-6">
          <div class="space-y-4">
            <div
              v-for="s in steps"
              :key="s.key"
              class="step-item flex items-start gap-3"
            >
              <!-- Step Icon -->
              <div class="step-icon-container shrink-0 mt-0.5">
                <CheckCircle2
                  v-if="isStepComplete(s.key)"
                  class="w-5 h-5 text-accent"
                />
                <Loader2
                  v-else-if="isStepActive(s.key)"
                  class="w-5 h-5 text-primary animate-spin"
                />
                <Circle
                  v-else
                  class="w-5 h-5 text-muted-foreground/40"
                />
              </div>

              <!-- Step Content -->
              <div class="flex-1">
                <h4
                  class="text-sm font-medium"
                  :class="{
                    'text-foreground': isStepActive(s.key) || isStepComplete(s.key),
                    'text-muted-foreground': !isStepActive(s.key) && !isStepComplete(s.key),
                  }"
                >
                  {{ s.label }}
                </h4>
                <p
                  v-if="isStepActive(s.key) && progress"
                  class="text-xs text-muted-foreground mt-0.5"
                >
                  {{ progress }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Error State -->
        <div
          v-if="claimStep === 'error'"
          class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-4"
        >
          <div class="flex items-start gap-3">
            <XCircle class="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-semibold text-destructive mb-1">Claim Failed</h4>
              <p class="text-sm text-muted-foreground">
                {{ claimError }}
              </p>
              <button
                type="button"
                class="text-sm text-primary hover:underline font-medium mt-2"
                @click="handleRetry"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>

        <!-- Success State -->
        <div
          v-if="claimStep === 'done'"
          class="success-box bg-accent/10 border border-accent/20 rounded-xl p-4"
        >
          <div class="flex items-start gap-3">
            <CheckCircle2 class="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-medium mb-1">Invitation Claimed!</h4>
              <p class="text-sm text-muted-foreground">
                Your identity has been secured with new keys. You can now access the dashboard.
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
          class="w-full h-12 text-base rounded-xl"
          :disabled="claimStep !== 'done'"
          @click="handleContinue"
        >
          <template v-if="claimStep === 'done'">
            Continue
            <ArrowRight class="w-4 h-4 ml-2" />
          </template>
          <template v-else>
            <Loader2 class="w-4 h-4 mr-2 animate-spin" />
            Processing...
          </template>
        </MBtn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useClaimIdentity, type ClaimStep } from 'composables/useClaimIdentity';
import { useOnboardingStore } from 'stores/onboarding';

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const store = useOnboardingStore();
const { step: claimStep, error: claimError, progress, claimIdentity, reset } = useClaimIdentity();

const stepOrder: ClaimStep[] = ['connecting', 'admitting', 'rotating', 'securing', 'done'];

const steps = [
  { key: 'connecting' as ClaimStep, label: 'Connecting to agent' },
  { key: 'admitting' as ClaimStep, label: 'Accepting credential grants' },
  { key: 'rotating' as ClaimStep, label: 'Rotating keys for security' },
  { key: 'securing' as ClaimStep, label: 'Generating recovery phrase' },
  { key: 'done' as ClaimStep, label: 'Claim complete' },
];

function isStepComplete(key: ClaimStep): boolean {
  const currentIdx = stepOrder.indexOf(claimStep.value);
  const stepIdx = stepOrder.indexOf(key);
  return currentIdx > stepIdx;
}

function isStepActive(key: ClaimStep): boolean {
  return claimStep.value === key;
}

onMounted(async () => {
  const passcode = store.claimPasscode;
  console.log('[ClaimProcessing] store.claimPasscode length:', passcode?.length);
  if (!passcode) {
    claimStep.value = 'error';
    claimError.value = 'No passcode available. Please use a valid claim link.';
    return;
  }
  await claimIdentity(passcode);
});

function handleContinue() {
  emit('continue');
}

function handleRetry() {
  reset();
  const passcode = store.claimPasscode;
  if (passcode) {
    claimIdentity(passcode);
  }
}
</script>

<style lang="scss" scoped>
.claim-processing-screen {
  background-color: var(--matou-background);
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.steps-container {
  background-color: var(--matou-card);
}

.error-box {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.success-box {
  background-color: rgba(74, 157, 156, 0.1);
  border-color: rgba(74, 157, 156, 0.2);
}
</style>
