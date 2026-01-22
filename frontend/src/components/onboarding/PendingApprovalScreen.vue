<template>
  <div class="pending-approval-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div
      class="header-gradient bg-gradient-to-br from-primary via-primary/95 to-accent p-6 md:p-8 pb-12 rounded-b-3xl relative overflow-hidden"
    >
      <!-- Animated background circle -->
      <div v-motion="backgroundPulse" class="bg-circle absolute top-0 right-0 w-64 h-64 bg-white rounded-full blur-3xl" />

      <div class="relative z-10">
        <div class="flex items-center gap-4 mb-6">
          <div class="logo-box bg-white/20 backdrop-blur-sm p-3 rounded-2xl">
            <img src="../../assets/images/matou-logo.svg" alt="Matou Logo" class="w-12 h-12" />
          </div>
          <div>
            <h1 class="text-white text-2xl md:text-3xl">Registration Pending</h1>
            <p class="text-white/80">Kia ora, {{ userName }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8 -mt-6">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Status Card -->
        <div
          v-motion="fadeSlideUp(100)"
          class="status-card bg-card border border-border rounded-2xl p-6 shadow-sm"
        >
          <div class="flex items-start gap-4">
            <div class="icon-box bg-primary/10 p-3 rounded-xl shrink-0">
              <div v-motion="rotate">
                <Clock class="w-6 h-6 text-primary" />
              </div>
            </div>
            <div class="flex-1">
              <h2 class="mb-2">Your application is under review</h2>
              <p class="text-muted-foreground mb-4">
                Thank you for your interest in joining Matou! Our admins have been notified of
                your registration and will review your application soon.
              </p>
              <div class="progress-box bg-secondary/50 rounded-xl p-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm text-muted-foreground">Typical review time</span>
                  <span class="text-sm font-medium">1-3 days</span>
                </div>
                <div class="progress-bar h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div v-motion="progressBar" class="progress-fill h-full bg-primary" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- What Happens Next -->
        <div v-motion="fadeSlideUp(200)">
          <h3 class="mb-4">What happens next?</h3>
          <div class="space-y-3">
            <div
              v-for="(step, index) in steps"
              :key="index"
              v-motion="slideInLeft(300 + index * 100)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">{{ step.step }}</span>
              </div>
              <div>
                <h4 class="mb-1">{{ step.title }}</h4>
                <p class="text-sm text-muted-foreground">{{ step.description }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Resources -->
        <div v-motion="fadeSlideUp(700)">
          <h3 class="mb-4">Explore while you wait</h3>
          <p class="text-muted-foreground mb-4">
            Learn more about Matou by browsing our documentation and resources
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            <button
              v-for="(resource, index) in resources"
              :key="index"
              v-motion="fadeSlideUp(800 + index * 100)"
              class="resource-card bg-card border border-border rounded-xl p-4 text-left hover:shadow-md transition-all hover:scale-[1.02] group"
            >
              <div class="flex items-start gap-3">
                <div class="icon-box bg-accent/10 p-2 rounded-lg shrink-0">
                  <component :is="resource.icon" class="w-5 h-5 text-accent" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <h4 class="truncate">{{ resource.title }}</h4>
                    <ExternalLink
                      class="external-link w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    />
                  </div>
                  <p class="text-sm text-muted-foreground">{{ resource.description }}</p>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- Help Section -->
        <div
          v-motion="fadeSlideUp(1200)"
          class="help-box bg-secondary/50 border border-border rounded-xl p-5"
        >
          <h4 class="mb-2">Need help?</h4>
          <p class="text-sm text-muted-foreground mb-4">
            If you have questions about your application or the review process, please contact
            our support team.
          </p>
          <MBtn variant="outline" class="w-full"> Contact Support </MBtn>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Clock, FileText, Users, Target, BookOpen, ExternalLink } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';

const { fadeSlideUp, slideInLeft, rotate, backgroundPulse, progressBar } = useAnimationPresets();

interface Props {
  userName: string;
}

withDefaults(defineProps<Props>(), {
  userName: 'Member',
});

const steps = [
  {
    step: '1',
    title: 'Admin Review',
    description: "An admin will review your registration details",
  },
  {
    step: '2',
    title: 'Approval Decision',
    description: "You'll receive notification of the decision",
  },
  {
    step: '3',
    title: 'Credential Issuance',
    description: 'Upon approval, your membership credential will be issued',
  },
  {
    step: '4',
    title: 'Welcome to Matou',
    description: 'Full access to governance, contributions, and community chat',
  },
];

const resources = [
  {
    icon: BookOpen,
    title: 'Community Handbook',
    description: 'Learn about governance processes and community guidelines',
    link: '#',
  },
  {
    icon: FileText,
    title: 'Documentation',
    description: 'Explore technical documentation and proposal templates',
    link: '#',
  },
  {
    icon: Target,
    title: 'Contribution Guidelines',
    description: "Discover how to contribute once you're approved",
    link: '#',
  },
  {
    icon: Users,
    title: 'About Working Groups',
    description: 'Learn about our various working groups and their focus areas',
    link: '#',
  },
];
</script>

<style lang="scss" scoped>
.pending-approval-screen {
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

.bg-circle {
  opacity: 0.1;
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

.status-card,
.step-card,
.resource-card {
  background-color: var(--matou-card);
}

.step-number {
  display: flex;
  align-items: center;
  justify-content: center;
}

.progress-box {
  background-color: rgba(232, 244, 248, 0.5);
}

.progress-bar {
  background-color: var(--matou-secondary);
}

.progress-fill {
  width: 0%;
}

.help-box {
  background-color: rgba(232, 244, 248, 0.5);
}

.external-link {
  opacity: 0;
  transition: opacity 0.2s ease;
}

.resource-card:hover .external-link {
  opacity: 1;
}
</style>
