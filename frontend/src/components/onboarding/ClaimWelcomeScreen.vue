<template>
  <div class="claim-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div
      class="header-gradient bg-gradient-to-br from-primary via-primary/95 to-accent p-6 md:p-8 pb-8 rounded-b-3xl"
    >
      <button
        class="mb-6 text-white/80 hover:text-white transition-colors"
        @click="emit('back')"
      >
        <ArrowLeft class="w-5 h-5" />
      </button>

      <div class="flex items-center gap-4 mb-4">
        <div class="logo-box bg-white/20 backdrop-blur-sm p-3 rounded-2xl">
          <img src="../../assets/images/matou-logo.svg" alt="Matou Logo" class="w-12 h-12" />
        </div>
        <div>
          <h1 class="text-white text-2xl md:text-3xl">
            Welcome, {{ aidInfo?.name || 'Member' }}
          </h1>
          <p class="text-white/80">You've been invited to join Matou</p>
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Identity Preview -->
        <div v-if="aidInfo" class="identity-card bg-card border border-border rounded-xl p-5">
          <div class="flex items-start gap-3">
            <div class="icon-box bg-accent/20 p-2 rounded-lg shrink-0">
              <Fingerprint class="w-5 h-5 text-accent" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-medium mb-1">Your Identity</h3>
              <p class="text-sm text-muted-foreground mb-2">{{ aidInfo.name }}</p>
              <div class="aid-preview bg-secondary/50 rounded-lg px-3 py-2">
                <code class="text-xs font-mono text-foreground/80 break-all">
                  {{ formatAid(aidInfo.prefix) }}
                </code>
              </div>
            </div>
          </div>
        </div>

        <!-- Invitation Notice -->
        <div class="notice-box bg-primary/10 border border-primary/20 rounded-2xl p-5">
          <div class="flex items-start gap-3">
            <div class="icon-box bg-primary/20 p-2 rounded-lg shrink-0">
              <Info class="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 class="mb-1">Invitation</h3>
              <p class="text-sm text-muted-foreground">
                An administrator has created a verified identity for you. By accepting this
                invitation, your cryptographic keys will be rotated for security and your
                membership credentials will be activated.
              </p>
            </div>
          </div>
        </div>

        <!-- About Matou -->
        <div>
          <h2 class="mb-4">About Matou</h2>
          <p class="text-muted-foreground mb-6">
            Matou is a DAO ecosystem built on principles of Indigenous sovereignty, relational
            identity, and community governance. We're creating a space where people can
            participate in meaningful governance, contribute to projects, and build lasting
            connections.
          </p>
        </div>

        <!-- Our Values -->
        <div>
          <h2 class="mb-4">Our Values</h2>
          <div class="grid gap-4 md:grid-cols-2">
            <div
              v-for="(value, index) in values"
              :key="index"
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
        <div>
          <h2 class="mb-4">Community Goals</h2>
          <div class="space-y-3">
            <div v-for="(item, index) in goals" :key="index" class="flex items-start gap-3">
              <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <p class="text-muted-foreground">{{ item }}</p>
            </div>
          </div>
        </div>

        <!-- Member Expectations -->
        <div>
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
        <MBtn
          class="w-full h-12 text-base rounded-xl"
          @click="handleContinue"
        >
          I agree, accept invitation
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Fingerprint,
  Info,
  Users,
  Heart,
  Target,
  Shield,
  CheckCircle,
} from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useOnboardingStore } from 'stores/onboarding';

const store = useOnboardingStore();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const aidInfo = store.claimAidInfo;

function formatAid(prefix: string): string {
  if (prefix.length <= 16) return prefix;
  return `${prefix.substring(0, 8)}...${prefix.substring(prefix.length - 4)}`;
}

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

function handleContinue() {
  emit('continue');
}
</script>

<style lang="scss" scoped>
.claim-welcome-screen {
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

.identity-card {
  background-color: var(--matou-card);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.value-card,
.expectations-card {
  background-color: var(--matou-card);
}

.aid-preview {
  background-color: var(--matou-secondary);
}
</style>
