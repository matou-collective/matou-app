<template>
  <div class="splash-screen h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div v-motion="fadeScale()" class="flex flex-col items-center gap-8 max-w-md w-full">
      <!-- Logo -->
      <div v-motion="logoWobble" class="logo-container bg-white/20 backdrop-blur-sm p-8 md:p-10 rounded-3xl">
        <img
          src="../../assets/images/matou-logo.svg"
          alt="Matou Logo"
          class="w-24 h-24 md:w-32 md:h-32"
        />
      </div>

      <!-- Title -->
      <div v-motion="fadeSlideUp(300)" class="text-center">
        <h1 class="text-white text-2xl md:text-5xl mb-2">Matou</h1>
        <p class="text-white/80 text-base md:text-lg">Community &middot; Connection &middot; Governance</p>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" v-motion="fadeSlideUp(600)" class="w-full text-center">
        <div class="loading-dots flex justify-center gap-2 mb-4">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
        <p class="text-white/80 text-base">Checking your identity...</p>
      </div>

      <!-- Error State -->
      <div v-else-if="hasError" v-motion="fadeSlideUp(600)" class="w-full space-y-4">
        <div class="error-banner bg-red-500/20 border border-red-400/30 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <AlertCircle class="w-5 h-5 text-red-300 flex-shrink-0 mt-0.5" />
            <div>
              <p class="text-white font-medium mb-1">Connection Error</p>
              <p class="text-white/70 text-sm">{{ errorMessage }}</p>
            </div>
          </div>
        </div>
        <MBtn
          class="w-full retry-btn"
          size="lg"
          @click="onRetry"
        >
          <RefreshCw class="w-5 h-5 mr-2" />
          Try Again
        </MBtn>
      </div>

      <!-- Entry Options (only show when ready and no error) -->
      <template v-else>
        <div v-motion="fadeSlideUp(600)" class="w-full space-y-3">
          <MBtn
            class="w-full invite-btn"
            size="lg"
            @click="onInviteCode"
          >
            <Key class="w-5 h-5 mr-2" />
            I have an invite code
          </MBtn>

          <MBtn
            variant="outline"
            class="w-full register-btn"
            size="lg"
            @click="onRegister"
          >
            <UserPlus class="w-5 h-5 mr-2" />
            Register
          </MBtn>
        </div>

        <!-- Info Text -->
        <p v-motion="fadeSlideUp(900)" class="text-white/60 text-sm text-center">
          Join the Matou community to participate in governance, contribute to projects, and
          connect with others
        </p>

        <!-- Recovery Link -->
        <button
          v-motion="fadeSlideUp(1100)"
          class="text-white/50 text-sm hover:text-white/80 transition-colors border-none"
          @click="onRecover"
        >
          Already have an account? <span class="underline">Recover identity</span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Key, UserPlus, AlertCircle, RefreshCw } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { useOnboardingStore } from 'stores/onboarding';

const { fadeSlideUp, fadeScale, logoWobble } = useAnimationPresets();
const onboardingStore = useOnboardingStore();

const isLoading = computed(() => onboardingStore.isLoading);
const hasError = computed(() => !!onboardingStore.initializationError);
const errorMessage = computed(() => onboardingStore.initializationError);

const emit = defineEmits<{
  (e: 'invite-code'): void;
  (e: 'register'): void;
  (e: 'recover'): void;
  (e: 'retry'): void;
}>();

const onInviteCode = () => {
  emit('invite-code');
};

const onRegister = () => {
  emit('register');
};

const onRecover = () => {
  emit('recover');
};

const onRetry = () => {
  emit('retry');
};
</script>

<style lang="scss" scoped>
.splash-screen {
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
  }
}

.invite-btn {
  background-color: #ffffff !important;
  color: var(--matou-primary) !important;
  height: 3.5rem !important;
  border-radius: var(--matou-radius-2xl) !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }
}

.register-btn {
  background-color: rgba(255, 255, 255, 0.1) !important;
  color: #ffffff !important;
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  height: 3.5rem !important;
  border-radius: var(--matou-radius-2xl) !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.2) !important;
  }
}

.retry-btn {
  background-color: #ffffff !important;
  color: var(--matou-primary) !important;
  height: 3.5rem !important;
  border-radius: var(--matou-radius-2xl) !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }
}

button.text-white\/50 {
  background-color: unset;
}

// Loading dots animation
.loading-dots {
  .dot {
    width: 10px;
    height: 10px;
    background-color: white;
    border-radius: 50%;
    animation: bounce 1.4s infinite ease-in-out both;

    &:nth-child(1) {
      animation-delay: -0.32s;
    }

    &:nth-child(2) {
      animation-delay: -0.16s;
    }

    &:nth-child(3) {
      animation-delay: 0s;
    }
  }
}

@keyframes bounce {
  0%, 80%, 100% {
    transform: scale(0);
    opacity: 0.5;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

.error-banner {
  backdrop-filter: blur(8px);
}
</style>
