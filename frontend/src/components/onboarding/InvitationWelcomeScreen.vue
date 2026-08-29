<template>
  <div class="invitation-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      title="Welcome to Matou"
      :subtitle="`You've been invited by ${inviterName}`"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Invitation Message -->
        <div
          v-motion="fadeSlideUp(100)"
          class="invitation-box bg-accent/10 border border-accent/20 rounded-2xl p-5"
        >
          <div class="flex items-start gap-3">
            <div class="icon-box bg-accent/20 p-2 rounded-lg shrink-0">
              <Users class="w-5 h-5 text-accent" />
            </div>
            <div>
              <h3 class="mb-1">You've been invited!</h3>
              <p class="text-sm text-muted-foreground">
                {{ inviterName }} has invited you to join the Matou community. They believe
                you'll be a valuable member of our DAO ecosystem.
              </p>
            </div>
          </div>
        </div>

        <!-- Matou Information Content -->
        <MatouInformationContent
          :use-animations="true"
          :show-member-expectations="false"
          :goals-title="'What to Expect'"
          :goals="expectations"
        />
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border pb-safe-area">
      <div class="max-w-2xl mx-auto">
        <MBtn class="w-full h-12 text-base rounded-xl" @click="onContinue">
          I agree, continue to profile creation
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          By continuing, you agree to uphold Matou's values and participate in good faith
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Users } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MatouInformationContent from './MatouInformationContent.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp } = useAnimationPresets();

interface Props {
  inviterName: string;
}

defineProps<Props>();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const expectations = [
  'Participate in governance decisions through proposals and voting',
  'Contribute to community projects and earn rewards',
  'Connect with members through regional and working group channels',
  'Receive verifiable credentials that prove your membership and contributions',
  'Be part of a community that values transparency and collective decision-making',
];

const onBack = () => {
  emit('back');
};

const onContinue = () => {
  emit('continue');
};
</script>

<style lang="scss" scoped>
.invitation-welcome-screen {
  background-color: var(--matou-background);
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.invitation-box {
  background-color: rgba(74, 157, 156, 0.1);
  border-color: rgba(74, 157, 156, 0.2);
}
</style>
