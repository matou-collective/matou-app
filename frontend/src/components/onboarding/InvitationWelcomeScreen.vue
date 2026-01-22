<template>
  <div class="invitation-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div
      class="header-gradient bg-gradient-to-br from-primary via-primary/95 to-accent p-6 md:p-8 pb-8 rounded-b-3xl"
    >
      <MBtn variant="ghost" size="icon" class="back-btn text-white mb-6" @click="onBack">
        <ArrowLeft class="w-5 h-5" />
      </MBtn>

      <div class="flex items-center gap-4 mb-4">
        <div class="logo-box bg-white/20 backdrop-blur-sm p-3 rounded-2xl">
          <img src="../../assets/images/matou-logo.svg" alt="Matou Logo" class="w-12 h-12" />
        </div>
        <div>
          <h1 class="text-white text-2xl md:text-3xl">Welcome to Matou</h1>
          <p class="text-white/80">You've been invited by {{ inviterName }}</p>
        </div>
      </div>
    </div>

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

        <!-- About Matou -->
        <div v-motion="fadeSlideUp(200)">
          <h2 class="mb-4">About Matou</h2>
          <p class="text-muted-foreground mb-6">
            Matou is a DAO ecosystem built on principles of Indigenous sovereignty, relational
            identity, and community governance. We're creating a space where people can
            participate in meaningful governance, contribute to projects, and build lasting
            connections.
          </p>
        </div>

        <!-- Our Values -->
        <div v-motion="fadeSlideUp(300)">
          <h2 class="mb-4">Our Values</h2>
          <div class="grid gap-4 md:grid-cols-2">
            <div
              v-for="(value, index) in values"
              :key="index"
              v-motion="staggerChildren(400, 100)(index)"
              class="value-card bg-card border border-border rounded-xl p-4"
            >
              <div class="flex items-start gap-3">
                <div class="icon-box bg-primary/10 p-2 rounded-lg shrink-0">
                  <component :is="value.icon" class="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h4 class="mb-1">{{ value.title }}</h4>
                  <p class="text-sm text-muted-foreground">{{ value.description }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Expectations -->
        <div v-motion="fadeSlideUp(800)">
          <h2 class="mb-4">What to Expect</h2>
          <div class="space-y-3">
            <div
              v-for="(item, index) in expectations"
              :key="index"
              class="flex items-start gap-3"
            >
              <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <p class="text-muted-foreground">{{ item }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
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
import { ArrowLeft, Users, Heart, Target, Shield, CheckCircle } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp, staggerChildren } = useAnimationPresets();

interface Props {
  inviterName: string;
}

defineProps<Props>();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const values = [
  {
    icon: Shield,
    title: 'Indigenous Sovereignty',
    description: 'Honoring Indigenous self-determination and autonomy',
  },
  {
    icon: Heart,
    title: 'Relational Identity',
    description: 'Building connections based on trust and reciprocity',
  },
  {
    icon: Target,
    title: 'Transparency',
    description: 'Open governance and clear decision-making processes',
  },
  {
    icon: Users,
    title: 'Community First',
    description: 'Collective wellbeing over individual gain',
  },
];

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

.header-gradient {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.95) 50%,
    var(--matou-accent) 100%
  );
}

.back-btn {
  &:hover {
    background-color: rgba(255, 255, 255, 0.2) !important;
  }
}

.logo-box {
  img {
    object-fit: contain;
  }
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

.value-card {
  background-color: var(--matou-card);
}
</style>
