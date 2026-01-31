<template>
  <div class="profile-confirmation-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
          <CheckCircle2 class="w-5 h-5 text-accent" />
        </div>
        <h1>{{ isClaim ? 'Save Your Recovery Phrase' : 'Identity Created Successfully' }}</h1>
      </div>
      <p class="text-muted-foreground">
        {{ isClaim
          ? 'This phrase lets you recover your identity — write it down and keep it safe'
          : 'Save your recovery phrase - it\'s the only way to restore your identity'
        }}
      </p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">

        <!-- ID Card -->
        <div class="id-card-container">
          <div class="id-card bg-gradient-to-br from-primary via-primary/95 to-accent rounded-2xl p-5 text-white shadow-xl">
            <!-- Card Header -->
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-2">
                <img src="../../assets/images/matou-logo.svg" alt="Matou" class="w-6 h-6 invert opacity-90" />
                <span class="text-xs font-medium opacity-90">MATOU IDENTITY</span>
              </div>
              <div class="flex items-center gap-1">
                <Shield class="w-3 h-3 opacity-75" />
                <span class="text-[10px] opacity-75">DECENTRALIZED</span>
              </div>
            </div>

            <!-- Profile Section -->
            <div class="flex items-center gap-4 mb-4">
              <!-- Avatar -->
              <div class="avatar-frame w-14 h-14 rounded-xl overflow-hidden border-2 border-white/30 bg-white/10 flex items-center justify-center shrink-0">
                <img
                  v-if="profile.avatarPreview"
                  :src="profile.avatarPreview"
                  alt="Profile"
                  class="w-full h-full object-cover"
                />
                <User v-else class="w-7 h-7 text-white/60" />
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0">
                <h2 class="text-lg font-semibold truncate">{{ profile.name }}</h2>
                <p class="text-xs text-white/70">Member</p>
              </div>
            </div>

            <!-- AID Section -->
            <div class="aid-section bg-black/20 rounded-lg p-3">
              <div class="flex items-center gap-1.5 mb-1">
                <Key class="w-3 h-3 opacity-75" />
                <span class="text-[10px] font-medium opacity-75">AUTONOMIC IDENTIFIER</span>
              </div>
              <div class="font-mono text-xs text-white/90 break-all">
                {{ userAID }}
              </div>
            </div>
          </div>
        </div>

        <!-- Critical Warning -->
        <div class="warning-box bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <AlertTriangle class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h4 class="text-sm font-semibold text-amber-600 mb-1">Save Your Recovery Phrase</h4>
              <ul class="text-sm text-muted-foreground space-y-1">
                <li>This is the <strong>only way</strong> to recover your identity</li>
                <li>Write it down on paper and store it safely</li>
                <li><strong>Never</strong> share it with anyone</li>
                <li>We cannot recover this for you</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Mnemonic Words Grid -->
        <div class="mnemonic-container bg-card border border-border rounded-xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-medium">Your 12-Word Recovery Phrase</h3>
            <button
              type="button"
              class="text-xs text-primary hover:underline flex items-center gap-1"
              @click="copyMnemonic"
            >
              <Copy class="w-3 h-3" />
              {{ copied ? 'Copied!' : 'Copy' }}
            </button>
          </div>

          <div class="grid grid-cols-3 gap-2">
            <div
              v-for="(word, index) in mnemonic.words"
              :key="index"
              class="word-card flex items-center gap-2 bg-secondary/50 border border-border rounded-lg px-3 py-2"
            >
              <span class="text-xs text-muted-foreground w-5">{{ index + 1 }}.</span>
              <span class="text-sm font-mono font-medium">{{ word }}</span>
            </div>
          </div>
        </div>

        <!-- Confirmation Checkbox -->
        <div class="confirm-box bg-secondary/50 border border-border rounded-xl p-4">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="hasWrittenDown"
              class="w-4 h-4 rounded border-border text-primary focus:ring-primary/50 shrink-0"
            />
            <span class="text-sm">
              I have written down my recovery phrase and stored it safely
            </span>
          </label>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
      <div class="max-w-2xl mx-auto">
        <MBtn
          class="w-full h-12 text-base rounded-xl"
          :disabled="!hasWrittenDown"
          @click="handleContinue"
        >
          Continue to Verification
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          You'll need to verify 3 words from your phrase on the next screen
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  ArrowRight,
  User,
  Key,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Copy,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useOnboardingStore } from 'stores/onboarding';

const store = useOnboardingStore();

const hasWrittenDown = ref(false);
const copied = ref(false);

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

// Get data from store
const isClaim = computed(() => store.onboardingPath === 'claim');
const profile = computed(() => store.profile);
const mnemonic = computed(() => store.mnemonic);
const userAID = computed(() => store.userAID || 'Loading...');

function copyMnemonic() {
  const text = mnemonic.value.words.join(' ');
  navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}

function handleContinue() {
  emit('continue');
}
</script>

<style lang="scss" scoped>
.profile-confirmation-screen {
  background-color: var(--matou-background);
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.id-card {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.95) 50%,
    var(--matou-accent) 100%
  );
}

.avatar-frame {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.aid-section {
  backdrop-filter: blur(4px);
}

.warning-box {
  background-color: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.mnemonic-container {
  background-color: var(--matou-card);
}

.word-card {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

.confirm-box {
  background-color: var(--matou-secondary);
}

input[type="checkbox"] {
  accent-color: var(--matou-primary);
}
</style>
