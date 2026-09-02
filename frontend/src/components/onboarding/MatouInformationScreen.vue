<template>
  <div class="matou-info-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      title="Join Mātou"
      subtitle="Learn about our community"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Registration Notice -->
        <div
          v-motion="fadeSlideUp(100)"
          class="notice-box bg-primary/10 border border-primary/20 rounded-2xl p-5"
        >
          <div class="flex items-start gap-3">
            <div class="icon-box bg-primary/20 p-2 rounded-lg shrink-0">
              <Info class="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 class="mb-1">Registration Process</h3>
              <p class="text-sm text-muted-foreground">
                New member registrations require admin approval. You'll have access to Mātou
                documentation while your application is reviewed. This typically takes 1-3
                days.
              </p>
            </div>
          </div>
        </div>

        <!-- Matou Information Content -->
        <MatouInformationContent :use-animations="true" />
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border pb-safe-area">
      <div class="max-w-2xl mx-auto">
        <MBtn class="w-full h-12 text-base rounded-xl" @click="onContinue">
          I agree, continue to registration
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          By continuing, you agree to uphold Mātou's values and await admin approval
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft, Info } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import MatouInformationContent from './MatouInformationContent.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp } = useAnimationPresets();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const onBack = () => {
  emit('back');
};

const onContinue = () => {
  emit('continue');
};
</script>

<style lang="scss" scoped>
.matou-info-screen {
  background-color: var(--matou-background);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}
</style>
