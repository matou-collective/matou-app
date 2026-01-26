<template>
  <Transition name="fade">
    <div
      v-if="show"
      class="welcome-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
    >
      <div class="content flex flex-col items-center gap-6 max-w-md text-center p-8">
        <!-- Success Icon -->
        <div class="">
          <img
            src="../../assets/images/matou-logo.svg"
            alt="Matou Logo"
            class="w-[250px] h-[140px]"
          />
        </div>

        <!-- Title -->
        <div v-motion="fadeSlideUp(300)" class="text-center">
          <img
            src="../../assets/images/matou-text-logo-white.svg"
            alt="Matou"
            class="matou-text-logo-white mb-2 mt-0 w-[300px] h-[100px] mx-auto"
          />
          <p class="text-white/80 text-base md:text-lg">Welcome to Matou, {{ displayName }}!</p>
        </div>

        <!-- Continue Button -->
        <MBtn class="w-full" @click="handleContinue">
          Enter Community
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ArrowRight } from 'lucide-vue-next';
import { useAnimationPresets } from 'composables/useAnimationPresets';
const { fadeSlideUp } = useAnimationPresets();
import MBtn from '../base/MBtn.vue';
import { useIdentityStore } from 'stores/identity';

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

function handleContinue() {
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
