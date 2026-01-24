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

      <!-- Entry Options -->
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
        class="text-white/50 text-sm hover:text-white/80 transition-colors"
        @click="onRecover"
      >
        Already have an account? <span class="underline">Recover identity</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Key, UserPlus } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp, fadeScale, logoWobble } = useAnimationPresets();

const emit = defineEmits<{
  (e: 'invite-code'): void;
  (e: 'register'): void;
  (e: 'recover'): void;
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
</style>
