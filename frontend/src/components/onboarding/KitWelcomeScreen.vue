<template>
  <div class="kit-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      :title="KIT.onboarding.welcome.heading"
      subtitle="Learn about our community"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Welcome body -->
        <div
          v-motion="fadeSlideUp(100)"
          class="prose max-w-none"
          v-html="renderMarkdown(KIT.onboarding.welcome.bodyMarkdown)"
        ></div>

        <!-- Approval sentence -->
        <div
          v-motion="fadeSlideUp(150)"
          class="notice-box bg-primary/10 border border-primary/20 rounded-2xl p-5"
        >
          <div class="flex items-start gap-3">
            <div class="icon-box bg-primary/20 p-2 rounded-lg shrink-0">
              <Info class="w-5 h-5 text-primary" />
            </div>
            <p class="text-sm text-muted-foreground">{{ approvalSentence }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border pb-safe-area">
      <div class="max-w-2xl mx-auto">
        <MBtn class="w-full h-12 text-base rounded-xl" @click="onContinue">
          Continue
        </MBtn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Info } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { renderMarkdown } from 'src/lib/markdown';
import { KIT } from 'src/generated/kit';
import type { KitApproval } from 'src/kit/types';

const { fadeSlideUp } = useAnimationPresets();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

// Local copy of COA's `approvalWords` (templates/src/community-page.ts).
// Task 8 replaces this with the shared kit helper.
function approvalWords(a: KitApproval): string {
  switch (a.mode) {
    case 'open':
      return 'Anyone can join straight away.';
    case 'admin':
      return 'An admin approves each new member.';
    case 'endorsements':
      return `New members need ${a.required} endorsements from existing members.`;
    case 'endorsements+session':
      return `New members need ${a.required} endorsements and attend a whakawhanaungatanga session before an admin approves them.`;
  }
}

const approvalSentence = computed(() => approvalWords(KIT.onboarding.approval));

const onBack = () => {
  emit('back');
};

const onContinue = () => {
  emit('continue');
};
</script>

<style lang="scss" scoped>
.kit-welcome-screen {
  background-color: var(--matou-background);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}
</style>
