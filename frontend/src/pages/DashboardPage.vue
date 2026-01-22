<template>
  <q-page class="dashboard-page p-6 md:p-8">
    <div class="max-w-4xl mx-auto">
      <div class="text-center mb-8">
        <h1 class="text-3xl mb-2">Welcome to Matou</h1>
        <p class="text-muted-foreground">
          You've successfully completed onboarding. The dashboard is coming soon.
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="card bg-card border border-border rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <div class="icon-box bg-primary/10 p-2 rounded-lg">
              <Home class="w-5 h-5 text-primary" />
            </div>
            <h3>Home</h3>
          </div>
          <p class="text-sm text-muted-foreground">
            View your activity feed and community updates
          </p>
        </div>

        <div class="card bg-card border border-border rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <div class="icon-box bg-accent/10 p-2 rounded-lg">
              <Wallet class="w-5 h-5 text-accent" />
            </div>
            <h3>Wallet</h3>
          </div>
          <p class="text-sm text-muted-foreground">
            Manage your credentials and digital assets
          </p>
        </div>

        <div class="card bg-card border border-border rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <div class="icon-box bg-primary/10 p-2 rounded-lg">
              <Vote class="w-5 h-5 text-primary" />
            </div>
            <h3>Proposals</h3>
          </div>
          <p class="text-sm text-muted-foreground">
            Participate in community governance and voting
          </p>
        </div>

        <div class="card bg-card border border-border rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <div class="icon-box bg-accent/10 p-2 rounded-lg">
              <MessageSquare class="w-5 h-5 text-accent" />
            </div>
            <h3>Chat</h3>
          </div>
          <p class="text-sm text-muted-foreground">
            Connect with community members and working groups
          </p>
        </div>
      </div>

      <div class="mt-8 text-center">
        <MBtn variant="outline" @click="restartOnboarding">
          Restart Onboarding (Demo)
        </MBtn>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { Home, Wallet, Vote, MessageSquare } from 'lucide-vue-next';
import MBtn from 'components/base/MBtn.vue';
import { useOnboardingStore } from 'stores/onboarding';

const router = useRouter();
const store = useOnboardingStore();

const restartOnboarding = () => {
  store.reset();
  router.push('/');
};
</script>

<style lang="scss" scoped>
.dashboard-page {
  background-color: var(--matou-background);
  min-height: 100vh;
}

.card {
  background-color: var(--matou-card);
  transition: box-shadow 0.2s ease;

  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  }
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
