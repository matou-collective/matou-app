<template>
  <q-page class="error-page flex flex-col items-center justify-center p-8">
    <div class="text-center max-w-md">
      <h1 class="text-6xl font-semibold text-primary mb-4">404</h1>
      <h2 class="text-2xl mb-2">Page Not Found</h2>
      <p class="text-muted-foreground mb-8">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <MBtn @click="goHome">
        <Home class="w-4 h-4 mr-2" />
        Go Home
      </MBtn>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { Home } from 'lucide-vue-next';
import MBtn from 'components/base/MBtn.vue';

const router = useRouter();

const goHome = () => {
  router.push('/');
};
</script>

<style lang="scss" scoped>
.error-page {
  background-color: var(--matou-background);
  min-height: 100vh;
}
</style>
