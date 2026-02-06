<template>
  <Transition name="fade">
    <div
      v-if="show"
      class="welcome-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
    >
      <div class="content flex flex-col items-center gap-6 max-w-md text-center p-8">
        <!-- Logo -->
        <div v-motion="fadeSlideUp(600)" class="">
          <img
            src="../../assets/images/matou-logo.svg"
            alt="Matou Logo"
            class="w-[250px] h-[140px]"
          />
        </div>

        <!-- Title -->
        <div v-motion="fadeSlideUp(1200)" class="text-center">
          <img
            src="../../assets/images/matou-text-logo-white.svg"
            alt="Matou"
            class="matou-text-logo-white mb-2 mt-0 w-[300px] h-[100px] mx-auto"
          />
        </div>

        <!-- Welcome Text - Rotating Indigenous Languages -->
        <p v-motion="fadeSlideUp(1800)" class="text-white/80 text-base md:text-lg -mt-4">
          <span class="welcome-word" :class="{ 'fade-out': wordFading }">{{ currentWelcome.word }}</span>, {{ displayName }}!
        </p>

        <!-- Sync Progress Steps -->
        <div v-if="!syncReady" v-motion="fadeSlideUp(3000)" class="sync-steps w-full">
          <div
            v-for="step in syncSteps"
            :key="step.key"
            class="flex items-center gap-3 mb-2"
          >
            <CheckCircle2 v-if="step.done" class="w-5 h-5 text-white/90 shrink-0" />
            <Loader2 v-else-if="step.active" class="w-5 h-5 text-white/80 animate-spin shrink-0" />
            <Circle v-else class="w-5 h-5 text-white/40 shrink-0" />
            <span
              class="text-sm"
              :class="{
                'text-white/90 font-medium': step.done || step.active,
                'text-white/50': !step.done && !step.active,
              }"
            >{{ step.label }}</span>
          </div>
        </div>

        <!-- Timeout warning -->
        <p v-if="timedOut && !syncReady" v-motion="fadeSlideUp(3600)" class="text-white/60 text-xs">
          Sync is taking longer than expected. You can enter anyway.
        </p>

        <!-- Continue Button -->
        <MBtn
          v-motion="fadeSlideUp(3600)"
          class="w-full"
          :disabled="!syncReady && !timedOut"
          @click="handleContinue"
        >
          <template v-if="syncReady">
            Enter Community
            <ArrowRight class="w-4 h-4 ml-2" />
          </template>
          <template v-else-if="timedOut">
            Enter Anyway
            <ArrowRight class="w-4 h-4 ml-2" />
          </template>
          <template v-else>
            Syncing...
          </template>
        </MBtn>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { ArrowRight, CheckCircle2, Loader2, Circle } from 'lucide-vue-next';
import { useAnimationPresets } from 'composables/useAnimationPresets';
const { fadeSlideUp } = useAnimationPresets();
import MBtn from '../base/MBtn.vue';
import { useIdentityStore } from 'stores/identity';
import { getSyncStatus } from 'src/lib/api/client';

interface Props {
  show: boolean;
  userName: string;
  credential?: any;
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
  userName: 'Member',
  credential: undefined,
});

const identityStore = useIdentityStore();

/** Prefer AID name (from membership identity), then truncated AID prefix, then userName prop. */
const displayName = computed(() => {
  const aid = identityStore.currentAID;
  if (aid?.name) return aid.name;
  const prefix = aid?.prefix ?? '';
  if (prefix.length > 20) return `${prefix.slice(0, 10)}...${prefix.slice(-6)}`;
  if (prefix) return prefix;
  return props.userName;
});

const emit = defineEmits<{
  (e: 'continue'): void;
}>();

// Welcome words in indigenous languages
const welcomeWords = [
  { word: 'Welcome', language: 'English' },
  { word: 'Nau mai', language: 'Māori' },
  { word: 'Oro mau', language: 'Cook Islands Maori' },
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
    // Fade out
    wordFading.value = true;
    // Change word after fade out completes
    setTimeout(() => {
      welcomeIndex.value = (welcomeIndex.value + 1) % welcomeWords.length;
      // Fade in
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

// Sync state
const communityReady = ref(false);
const readOnlyReady = ref(false);
const syncReady = computed(() => communityReady.value && readOnlyReady.value);
const timedOut = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

const syncSteps = computed(() => [
  {
    key: 'community',
    label: 'Syncing community data...',
    done: communityReady.value,
    active: !communityReady.value && !readOnlyReady.value,
  },
  {
    key: 'readonly',
    label: 'Loading community info...',
    done: readOnlyReady.value,
    active: communityReady.value && !readOnlyReady.value,
  },
  {
    key: 'ready',
    label: 'Ready!',
    done: syncReady.value,
    active: false,
  },
]);

async function pollSyncStatus() {
  try {
    const status = await getSyncStatus();
    communityReady.value = status.community.hasObjectTree;
    readOnlyReady.value = status.readOnly.hasObjectTree;
    if (status.ready) {
      stopPolling();
    }
  } catch {
    // Ignore errors, keep polling
  }
}

function startSyncPolling() {
  stopPolling();
  // Poll immediately, then every 2.5 seconds
  pollSyncStatus();
  pollTimer = setInterval(pollSyncStatus, 2500);
  // Timeout fallback: allow entering after 30 seconds
  timeoutTimer = setTimeout(() => {
    timedOut.value = true;
  }, 30000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
}

// Start polling and welcome rotation when overlay becomes visible
watch(() => props.show, (shown) => {
  if (shown) {
    // Reset state
    communityReady.value = false;
    readOnlyReady.value = false;
    timedOut.value = false;
    startSyncPolling();
    // Start welcome rotation after the welcome text fades in (2400ms delay + some buffer)
    setTimeout(() => {
      startWelcomeRotation();
    }, 2400);
  } else {
    stopPolling();
    stopWelcomeRotation();
  }
});

onUnmounted(() => {
  stopPolling();
  stopWelcomeRotation();
});

function handleContinue() {
  stopPolling();
  emit('continue');
}
</script>

<style lang="scss" scoped>
.welcome-overlay {
  // Primary color (#1e5f74) with 95% opacity
  background-color: rgba(30, 95, 116, 0.95);
}

.icon-container {
  .icon-bg {
    position: relative;
    z-index: 1;
  }

  .ring {
    pointer-events: none;
  }

  .ring-1 {
    animation: ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
}

@keyframes ping {
  75%, 100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

.credential-card {
  background-color: var(--matou-card);
}

.status-badge {
  white-space: nowrap;
}

.sync-steps {
  max-width: 280px;
}

.welcome-word {
  display: inline-block;
  transition: opacity 0.4s ease;
}

.welcome-word.fade-out {
  opacity: 0;
}

// Transition
.fade-enter-active {
  transition: opacity 0.4s ease;
}

.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
