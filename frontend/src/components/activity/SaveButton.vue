<template>
  <button
    class="save-btn"
    :class="{ saved: isSaved }"
    @click.stop="handleSave"
  >
    <Bookmark :size="16" :fill="isSaved ? 'currentColor' : 'none'" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Bookmark } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();

const isSaved = computed(() => activityStore.isSaved(props.noticeId));

async function handleSave() {
  await activityStore.handleToggleSave(props.noticeId);
}
</script>

<style scoped>
.save-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: color 0.15s;
}

.save-btn:hover {
  color: var(--matou-primary);
}

.save-btn.saved {
  color: var(--matou-primary);
}
</style>
