<template>
  <div class="claim-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div
      class="header-gradient bg-gradient-to-br from-primary via-primary/95 to-accent p-6 md:p-8 pb-8 rounded-b-3xl"
    >
      <div class="flex items-center gap-4 mb-4">
        <div class="logo-box bg-white/20 backdrop-blur-sm p-3 rounded-2xl">
          <img src="../../assets/images/matou-logo.svg" alt="Matou Logo" class="w-12 h-12" />
        </div>
        <div>
          <h1 class="text-white text-2xl md:text-3xl">Your Identity is Ready</h1>
          <p class="text-white/80">Claim your pre-created Matou identity</p>
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Loading State -->
        <div v-if="isValidating" class="text-center py-8">
          <Loader2 class="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
          <p class="text-muted-foreground">Connecting to your identity...</p>
        </div>

        <!-- Error State -->
        <div v-else-if="validationError" class="space-y-4">
          <div class="error-box bg-destructive/10 border border-destructive/30 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <XCircle class="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <h4 class="text-sm font-semibold text-destructive mb-1">Invalid Claim Link</h4>
                <p class="text-sm text-muted-foreground">
                  {{ validationError }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Valid State -->
        <template v-else-if="aidInfo">
          <!-- Identity Preview -->
          <div class="identity-card bg-card border border-border rounded-xl p-5">
            <div class="flex items-start gap-3">
              <div class="icon-box bg-accent/20 p-2 rounded-lg shrink-0">
                <Fingerprint class="w-5 h-5 text-accent" />
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-medium mb-1">Your Identity</h3>
                <p class="text-sm text-muted-foreground mb-2">{{ aidInfo.name }}</p>
                <div class="aid-preview bg-secondary/50 rounded-lg px-3 py-2">
                  <code class="text-xs font-mono text-foreground/80 break-all">
                    {{ formatAid(aidInfo.prefix) }}
                  </code>
                </div>
              </div>
            </div>
          </div>

          <!-- Explanation -->
          <div class="explanation-box bg-primary/10 border border-primary/20 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <Shield class="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium mb-1">What happens next</h4>
                <p class="text-sm text-muted-foreground">
                  An admin has prepared a verified identity for you. When you continue,
                  we'll accept your membership credentials, rotate your cryptographic keys
                  for security, and generate a personal recovery phrase that only you will know.
                </p>
              </div>
            </div>
          </div>

          <!-- Security Note -->
          <div class="security-box bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <KeyRound class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h4 class="text-sm font-semibold text-amber-600 mb-1">Key Rotation</h4>
                <p class="text-sm text-muted-foreground">
                  After claiming, the invitation link will no longer work.
                  Your identity will be secured with new keys that only you control.
                </p>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
      <div class="max-w-2xl mx-auto">
        <MBtn
          class="w-full h-12 text-base rounded-xl"
          :disabled="!aidInfo || isValidating"
          @click="handleContinue"
        >
          Claim My Identity
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          You'll receive your recovery phrase after claiming
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  ArrowRight,
  Shield,
  KeyRound,
  Fingerprint,
  Loader2,
  XCircle,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useClaimIdentity } from 'composables/useClaimIdentity';

interface Props {
  passcode: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const { validate } = useClaimIdentity();

const isValidating = ref(true);
const validationError = ref<string | null>(null);
const aidInfo = ref<{ name: string; prefix: string } | null>(null);

function formatAid(prefix: string): string {
  if (prefix.length <= 16) return prefix;
  return `${prefix.substring(0, 8)}...${prefix.substring(prefix.length - 4)}`;
}

onMounted(async () => {
  if (!props.passcode) {
    validationError.value = 'No passcode provided in the claim link.';
    isValidating.value = false;
    return;
  }

  try {
    const result = await validate(props.passcode);
    if (result) {
      aidInfo.value = result;
    } else {
      validationError.value = 'This claim link is invalid or has already been used. The identity may have already been claimed.';
    }
  } catch (err) {
    validationError.value = err instanceof Error ? err.message : 'Failed to connect to identity agent.';
  } finally {
    isValidating.value = false;
  }
});

function handleContinue() {
  emit('continue');
}
</script>

<style lang="scss" scoped>
.claim-welcome-screen {
  background-color: var(--matou-background);
}

.header-gradient {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.95) 50%,
    var(--matou-accent) 100%
  );
}

.logo-box {
  img {
    object-fit: contain;
  }
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.identity-card {
  background-color: var(--matou-card);
}

.explanation-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.security-box {
  background-color: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.error-box {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.aid-preview {
  background-color: var(--matou-secondary);
}
</style>
