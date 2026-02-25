<template>
  <div class="matou-information-content space-y-6">
    <!-- About Matou -->
    <div v-if="showAbout" v-motion="animationConfig(200)">
      <h2 class="mb-4">About Matou</h2>
      <p class="text-muted-foreground mb-6">
        Matou is an indigenous led digital community built for the purpose of open innovation and collaboration to support data sovereignty and community autonomy. 
        We're creating a space where people can participate in meaningful governance, contribute to projects, and build lasting connections.
      </p>
    </div>

    <!-- Our Values -->
    <div v-if="showValues">
      <h2 class="mb-4" v-motion="animationConfig(300)">Our Values</h2>
      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="(value, index) in values"
          :key="index"
          v-motion="getValueAnimation(index)"
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
    <div v-if="showCommunityGoals" v-motion="animationConfig(800)">
      <h2 class="mb-4">{{ goalsTitle }}</h2>
      <div class="space-y-3">
        <div v-for="(item, index) in displayGoals" :key="index" class="flex items-start gap-3">
          <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
          <p class="text-muted-foreground">{{ item }}</p>
        </div>
      </div>
    </div>

    <!-- Member Expectations -->
    <div v-if="showMemberExpectations" v-motion="animationConfig(1000)">
      <h2 class="mb-4">{{ expectationsTitle }}</h2>
      <div class="expectations-card bg-card border border-border rounded-xl p-5 space-y-3">
        <p v-if="expectationsIntro" class="text-muted-foreground">{{ expectationsIntro }}</p>
        <ul class="space-y-2 text-sm text-muted-foreground">
          <li
            v-for="(expectation, index) in displayExpectations"
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
</template>

<script setup lang="ts">
import { Users, Heart, Target, Shield, CheckCircle } from 'lucide-vue-next';
import { computed } from 'vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

interface Props {
  showAbout?: boolean;
  showValues?: boolean;
  showCommunityGoals?: boolean;
  showMemberExpectations?: boolean;
  useAnimations?: boolean;
  goals?: string[];
  goalsTitle?: string;
  expectations?: string[];
  expectationsTitle?: string;
  expectationsIntro?: string;
}

const props = withDefaults(defineProps<Props>(), {
  showAbout: true,
  showValues: true,
  showCommunityGoals: true,
  showMemberExpectations: true,
  useAnimations: false,
  goalsTitle: "Community Goals",
  expectationsTitle: "Member Expectations",
  expectationsIntro: "As a member of Matou, you'll be expected to:",
});

const { fadeSlideUp, staggerChildren } = useAnimationPresets();

const animationConfig = (delay: number) => {
  return props.useAnimations ? fadeSlideUp(delay) : undefined;
};

const getValueAnimation = (index: number) => {
  if (!props.useAnimations) {
    // Return a no-op animation config that keeps elements visible
    return { 
      initial: { opacity: 1, y: 0 }, 
      enter: { opacity: 1, y: 0 } 
    };
  }
  // Use shorter delays to ensure all items animate in quickly
  return staggerChildren(300, 50)(index);
};

const values = [
  {
    icon: Shield,
    title: 'Indigenous Sovereignty',
    description: 'Honoring Indigenous self-determination and autonomy',
  },
  {
    icon: Heart,
    title: 'Community First',
    description: 'Being community led in all our decisions and actions',
  },
  {
    icon: Target,
    title: 'Transparency',
    description: 'Open governance and clear decision-making processes',
  },
  {
    icon: Users,
    title: 'Collective Wellbeing',
    description: 'Prioritizing the health and prosperity of the community as a whole',
  },
];

const defaultGoals = [
  'Create sustainable digital infrastructure that supports Indigenous sovereignty',
  'Build decentralized systems that enable self-determination and autonomy',
  'Develop technology solutions that honor Indigenous knowledge and practices',
  'Establish resilient networks that protect community data and digital rights',
  'Foster innovation that serves collective wellbeing and long-term sustainability',
];

const defaultExpectations = [
  'Uphold our values and support our community goals',
  'Participate in governance with respect and good faith',
  'Contribute to the community in ways that align with collective wellbeing',
  'Engage in open and transparent communication',
];

const displayGoals = computed(() => props.goals || defaultGoals);
const displayExpectations = computed(() => props.expectations || defaultExpectations);
</script>

<style lang="scss" scoped>
.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.value-card,
.expectations-card {
  background-color: var(--matou-card);
}

/* Ensure grid items are properly displayed */
.grid {
  display: grid;
}

/* Fallback: ensure value cards are visible after animation should complete */
.value-card {
  animation: ensureVisible 0.1s 1s forwards;
}

@keyframes ensureVisible {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
