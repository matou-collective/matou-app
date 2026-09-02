<template>
  <div class="info-pages-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      :title="page.title"
      subtitle="Learn about our community"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto">
        <div
          v-motion="fadeSlideUp(100)"
          class="prose max-w-none"
          v-html="renderMarkdown(page.bodyMarkdown)"
        ></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border pb-safe-area">
      <div class="max-w-2xl mx-auto">
        <MBtn class="w-full h-12 text-base rounded-xl" @click="onContinue">
          {{ isLastPage ? 'I agree, continue to registration' : 'Continue' }}
        </MBtn>
        <p v-if="isLastPage" class="text-xs text-muted-foreground text-center mt-3">
          By continuing, you agree to uphold our values and await approval
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { renderMarkdown } from 'src/lib/markdown';
import { KIT } from 'src/generated/kit';

const props = defineProps<{ index: number }>();

const { fadeSlideUp } = useAnimationPresets();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const page = computed(() => KIT.onboarding.infoPages[props.index] ?? { title: '', bodyMarkdown: '' });
const isLastPage = computed(() => props.index >= KIT.onboarding.infoPages.length - 1);

const onBack = () => {
  emit('back');
};

const onContinue = () => {
  emit('continue');
};
</script>

<style lang="scss" scoped>
.info-pages-screen {
  background-color: var(--matou-background);
}
</style>
