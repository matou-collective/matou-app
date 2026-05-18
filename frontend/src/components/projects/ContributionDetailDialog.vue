<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <ContributionDetailBody
      :contribution="contribution"
      :user-role="userRole"
      :current-user-id="currentUserId"
      :current-user-name="currentUserName"
      :all-contributions="allContributions"
      :is-plan-signed-off="isPlanSignedOff"
      :can-archive="canArchive"
      @close="emit('update:modelValue', false)"
      @update="(c) => emit('update', c)"
      @create-child-contribution="(p) => emit('create-child-contribution', p)"
      @edit-contribution="(c) => emit('edit-contribution', c)"
      @edit-sub-contribution="(c) => emit('edit-sub-contribution', c)"
      @archive-contribution="(c) => emit('archive-contribution', c)"
      @archive-sub-contribution="(c) => emit('archive-sub-contribution', c)"
    />
  </q-dialog>
</template>

<script setup lang="ts">
import type { Contribution } from 'src/types/projects';
import ContributionDetailBody from 'src/components/contributions/ContributionDetailBody.vue';

defineOptions({ name: 'ContributionDetailDialog' });

interface Props {
  modelValue: boolean;
  contribution: Contribution;
  userRole?: string;
  currentUserId?: string;
  currentUserName?: string;
  allContributions?: Contribution[];
  isPlanSignedOff?: boolean;
  canArchive?: boolean;
}

withDefaults(defineProps<Props>(), {
  userRole: 'member',
  currentUserId: '',
  currentUserName: '',
  allContributions: () => [],
  isPlanSignedOff: false,
  canArchive: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'update', contribution: Contribution): void;
  (e: 'create-child-contribution', parentId: string): void;
  (e: 'edit-contribution', contribution: Contribution): void;
  (e: 'edit-sub-contribution', contribution: Contribution): void;
  (e: 'archive-contribution', contribution: Contribution): void;
  (e: 'archive-sub-contribution', contribution: Contribution): void;
}>();
</script>
