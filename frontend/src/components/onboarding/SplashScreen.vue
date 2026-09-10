<template>
  <div class="splash-screen h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div v-motion="fadeScale()" class="flex flex-col items-center gap-8 max-w-md w-full">
      <!-- Logo -->
      <div v-motion="logoWobble" class="logo-container backdrop-blur-sm rounded-3xl">
        <img
          :src="kitLogo"
          :alt="`${KIT.brand.name} Logo`"
          class="w-[250px] h-[140px]"
        />
      </div>

      <!-- Title -->
      <div v-motion="fadeSlideUp(300)" class="text-center">
        <h1 class="text-white text-4xl font-bold mb-2">{{ KIT.brand.name }}</h1>
        <p v-if="KIT.brand.tagline" class="text-white/80 text-base md:text-lg">{{ KIT.brand.tagline }}</p>
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

          <!-- Linked-device sign-in (#473): on mobile, sign in with the
               computer instead of minting a second identity. Sits above
               "Join Now" as the cheapest defence against a second registration. -->
          <template v-if="showLinkDevice">
            <MBtn
              class="w-full link-device-btn"
              size="lg"
              @click="onLinkDevice"
            >
              <Laptop class="w-5 h-5 mr-2" />
              Sign in with your computer
            </MBtn>
            <p class="link-device-hint text-white/60 text-xs text-center -mt-1">
              Already a member on your computer? Sign in here instead of joining again.
            </p>
          </template>

          <MBtn
            variant="outline"
            class="w-full register-btn"
            size="lg"
            @click="onRegister"
          >
            <UserPlus class="w-5 h-5 mr-2" />
            Join Now
          </MBtn>

          <!-- Desktop-only: link this computer to an identity already on a phone
               (linked-device sign-in, #466). Hidden in plain-browser builds. -->
          <MBtn
            v-if="showLinkButton"
            variant="outline"
            class="w-full link-btn"
            size="lg"
            @click="onLink"
          >
            <Smartphone class="w-5 h-5 mr-2" />
            Sign in with your phone
          </MBtn>
        </div>

        <!-- Info Text -->
        <p v-motion="fadeSlideUp(900)" class="text-white/60 text-sm text-center">
          Join the {{ KIT.brand.name }} community to participate in governance, contribute to projects, and
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

    <!-- Version -->
    <span class="version-label">v{{ appVersion }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { Key, UserPlus, AlertCircle, RefreshCw, Smartphone, Laptop } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { isElectron } from 'src/lib/platform';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { useKERIClient } from 'src/lib/keri/client';
import { MEMBERSHIP_SCHEMA_SAID } from 'src/composables/useAdminActions';
import { version as appVersion } from '../../../package.json';
import { KIT } from 'src/generated/kit';
import kitLogo from 'src/assets/kit/logo.png';
import { isCapacitor } from 'src/lib/capacitor';

const { fadeSlideUp, fadeScale, logoWobble } = useAnimationPresets();
const onboardingStore = useOnboardingStore();
const identityStore = useIdentityStore();
const keriClient = useKERIClient();

// Desktops show the QR "Sign in with your phone" entry; phones show the
// scanner (S6) and plain-browser builds show neither (out of scope).
const showLinkButton = computed(() => isElectron());

const isLoading = computed(() => onboardingStore.isLoading);
const hasError = computed(() => !!onboardingStore.initializationError);
const errorMessage = computed(() => onboardingStore.initializationError);

// Linked-device sign-in (#473) is only offered inside the Capacitor shell,
// where the camera + embedded backend make scanning the computer's QR possible.
const showLinkDevice = isCapacitor();

// When loading finishes and user has identity, check credential and route
watch(
  () => onboardingStore.appState,
  async (state) => {
    if (state !== 'ready') return;
    if (!identityStore.hasIdentity || !identityStore.currentAID) return;

    console.log('[Splash] Identity found, checking for credential...');

    try {
      const client = keriClient.getSignifyClient();
      if (!client) {
        console.log('[Splash] No KERI client, routing to pending-approval');
        onboardingStore.navigateTo('pending-approval');
        return;
      }

      const credentials = await client.credentials().list();
      console.log(`[Splash] Found ${credentials.length} credentials`);

      const myAid = identityStore.currentAID!.prefix;
      const hasMembership = credentials.some(
        (c: { sad?: { s?: string; a?: { i?: string } } }) =>
          c.sad?.s === MEMBERSHIP_SCHEMA_SAID && c.sad?.a?.i === myAid
      );

      if (hasMembership) {
        // Has membership credential — verify community space access before routing
        const hasAccess = await identityStore.verifyCommunityAccess();
        if (hasAccess) {
          console.log('[Splash] Membership credential + community access confirmed, routing to welcome-overlay');
          onboardingStore.setPath('returning');
          onboardingStore.navigateTo('welcome-overlay');
        } else {
          console.log('[Splash] Membership credential found but no community access, routing to pending-approval');
          onboardingStore.navigateTo('pending-approval');
        }
      } else {
        // No membership credential - go to pending approval
        console.log('[Splash] No membership credential, routing to pending-approval');
        onboardingStore.navigateTo('pending-approval');
      }
    } catch (err) {
      console.error('[Splash] Error checking credentials:', err);
      // On error, go to pending approval to poll
      onboardingStore.navigateTo('pending-approval');
    }
  },
  { immediate: true }
);

const emit = defineEmits<{
  (e: 'invite-code'): void;
  (e: 'register'): void;
  (e: 'recover'): void;
  (e: 'link'): void;
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

// Desktop (Electron) "Sign in with your phone" → QR screen (#472).
const onLink = () => {
  emit('link');
};

// Mobile (Capacitor) "Sign in with your computer" → scan screen (#473).
const onLinkDevice = () => {
  emit('link');
};

const onRetry = () => {
  emit('retry');
};
</script>

<style lang="scss" scoped>
.splash-screen {
  position: relative;
  background: linear-gradient(
    160deg,
    var(--matou-brand) 0%,
    color-mix(in srgb, var(--matou-brand) 80%, black) 100%
  );
  min-height: calc(100vh - var(--titlebar-height));
}

.logo-container {
  img {
    object-fit: contain;
    line-height: 0;
  }
}

.invite-btn {
  background-color: #ffffff !important;
  color: var(--matou-brand) !important;
  height: 3.5rem !important;
  border-radius: 10px !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }
}

.link-device-btn {
  background-color: #ffffff !important;
  color: var(--matou-brand) !important;
  height: 3.5rem !important;
  border-radius: 10px !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }
}

.register-btn {
  background-color: rgba(255, 255, 255, 0.1) !important;
  color: #ffffff !important;
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  height: 3.5rem !important;
  border-radius: 10px !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.2) !important;
  }
}

.link-btn {
  background-color: rgba(255, 255, 255, 0.1) !important;
  color: #ffffff !important;
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  height: 3.5rem !important;
  border-radius: 10px !important;

  &:hover {
    background-color: rgba(255, 255, 255, 0.2) !important;
  }
}

.retry-btn {
  background-color: #ffffff !important;
  color: var(--matou-brand) !important;
  height: 3.5rem !important;
  border-radius: 10px !important;

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

.version-label {
  position: absolute;
  bottom: 1.5rem;
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.4);
}
</style>
