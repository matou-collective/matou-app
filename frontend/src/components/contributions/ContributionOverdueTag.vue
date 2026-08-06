<template>
  <span class="overdue-tag">
    <q-icon name="alarm" size="12px" />
    Overdue
  </span>
</template>

<script setup lang="ts">
// Floating "Overdue" label used on ContributionCard / ContributionCardCompact.
// Positioned absolutely — the parent card must have `position: relative`.
defineOptions({ name: 'ContributionOverdueTag' });
</script>

<style scoped lang="scss">
@import 'src/css/contribution-status.scss';

.overdue-tag {
  @include contribution-overdue-tag;
}
</style>
