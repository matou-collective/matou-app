<template>
  <div
    class="header-gradient bg-gradient-to-br from-primary via-primary/95 to-accent p-6 md:p-8 pb-8 rounded-b-3xl"
  >
    <MBtn
      v-if="showBackButton"
      variant="ghost"
      size="icon"
      class="back-btn text-white mb-6"
      @click="handleBack"
    >
      <ArrowLeft class="w-5 h-5 text-white" />
    </MBtn>

    <div class="flex items-center gap-8 mb-4">
      <div v-if="!showIcon" class="logo-box bg-white/20 backdrop-blur-sm p-3 rounded-2xl">
        <img src="../../assets/images/matou-logo.svg" alt="Matou Logo" class="w-12 h-12" />
      </div>
      <div v-else class="icon-box w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
        <component :is="icon" class="w-5 h-5 text-white" />
      </div>
      <div>
        <h1 class="text-white text-2xl md:text-3xl">{{ title }}</h1>
        <p v-if="subtitle" class="text-white/80">{{ subtitle }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import type { Component } from 'vue';
import MBtn from '../base/MBtn.vue';

interface Props {
  title: string;
  subtitle?: string;
  showBackButton?: boolean;
  icon?: Component;
  showIcon?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showBackButton: false,
  showIcon: false,
});

const emit = defineEmits<{
  (e: 'back'): void;
}>();

const handleBack = () => {
  emit('back');
};
</script>

<style lang="scss" scoped>
.header-gradient {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.95) 50%,
    var(--matou-accent) 100%
  );
}

.back-btn {
  color: white !important;
  
  &:hover {
    background-color: rgba(255, 255, 255, 0.2) !important;
  }
  
  :deep(svg) {
    color: white !important;
  }
}

.logo-box {
  img {
    object-fit: contain;
  }
}
</style>
