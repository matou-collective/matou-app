<template>
  <div class="matou-info-screen h-full flex flex-col bg-background">
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
          <h1 class="text-white text-2xl md:text-3xl">Join Matou</h1>
          <p class="text-white/80">Learn about our community</p>
        </div>
      </div>
    </div>

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
                New member registrations require admin approval. You'll have access to Matou
                documentation while your application is reviewed. This typically takes 1-3
                days.
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

        <!-- Community Goals -->
        <div v-motion="fadeSlideUp(800)">
          <h2 class="mb-4">Community Goals</h2>
          <div class="space-y-3">
            <div v-for="(item, index) in goals" :key="index" class="flex items-start gap-3">
              <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <p class="text-muted-foreground">{{ item }}</p>
            </div>
          </div>
        </div>

        <!-- Member Expectations -->
        <div v-motion="fadeSlideUp(1000)">
          <h2 class="mb-4">Member Expectations</h2>
          <div class="expectations-card bg-card border border-border rounded-xl p-5 space-y-3">
            <p class="text-muted-foreground">As a member of Matou, you'll be expected to:</p>
            <ul class="space-y-2 text-sm text-muted-foreground">
              <li
                v-for="(expectation, index) in expectations"
                :key="index"
                class="flex items-start gap-2"
              >
                <span class="text-primary mt-1">&bull;</span>
                <span>{{ expectation }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border">
      <div class="max-w-2xl mx-auto">
        <MBtn class="w-full h-12 text-base rounded-xl" @click="onContinue">
          I agree, continue to registration
        </MBtn>
        <p class="text-xs text-muted-foreground text-center mt-3">
          By continuing, you agree to uphold Matou's values and await admin approval
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft, Users, Heart, Target, Shield, CheckCircle, Info } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp, staggerChildren } = useAnimationPresets();

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

const goals = [
  'Foster Indigenous sovereignty through decentralized governance',
  'Create meaningful connections based on shared values and mutual respect',
  'Enable transparent decision-making that serves the collective good',
  'Build systems that honor both individual identity and community relationships',
  'Support projects that align with our values and benefit the wider community',
];

const expectations = [
  'Uphold our values of Indigenous sovereignty and relational identity',
  'Participate in governance with respect and good faith',
  'Contribute to the community in ways that align with collective wellbeing',
  'Engage in open and transparent communication',
];

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

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.value-card,
.expectations-card {
  background-color: var(--matou-card);
}
</style>
