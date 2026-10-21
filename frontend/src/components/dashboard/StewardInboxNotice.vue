<template>
  <div v-if="show" data-test="steward-inbox-notice" class="steward-inbox-notice card">
    <div class="notice-content">
      <span class="notice-icon" aria-hidden="true">⚠</span>
      <div class="notice-text">
        <strong class="notice-headline">{{ headline }}</strong>
        <p class="notice-hint">
          This wallet could not apply some changes from other stewards. Ask the
          founder to re-issue the credentials below if a revoke or update seems
          to have had no effect.
        </p>
        <template v-if="affected.length > 0">
          <button
            type="button"
            class="notice-toggle"
            data-test="steward-inbox-toggle"
            @click="expanded = !expanded"
          >
            {{ expanded ? 'Hide affected members' : `Show affected members (${affected.length})` }}
          </button>
          <ul v-if="expanded" class="notice-affected" data-test="steward-inbox-affected-list">
            <li
              v-for="m in affected"
              :key="m.said"
              class="notice-affected-item"
              data-test="steward-inbox-affected"
            >
              {{ m.name || shortSaid(m.said) }}
            </li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

export interface AffectedMember {
  /** Credential SAID this wallet could not apply. */
  said: string;
  /** Resolved member display name, or null when it could not be mapped. */
  name: string | null;
}

const props = defineProps<{
  /** The inbox's `lastError` headline (already folds `skippedActsMessage`). */
  message: string | null;
  /** Credentials this wallet skipped, mapped to members for display. */
  affected?: AffectedMember[];
  /** The inbox's `pending` count (notes still unapplied). */
  pendingCount?: number;
}>();

const expanded = ref(false);
const affected = computed(() => props.affected ?? []);
const pendingCount = computed(() => props.pendingCount ?? 0);

// Prefer the inbox's own message; fall back to the same phrasing the inbox
// uses for unapplied changes when only a pending count is known.
const headline = computed(
  () => props.message || (pendingCount.value > 0 ? `${pendingCount.value} change(s) from other stewards not applied yet` : ''),
);

const show = computed(() => !!headline.value || affected.value.length > 0);

function shortSaid(said: string): string {
  return said.length > 14 ? `${said.slice(0, 12)}…` : said;
}
</script>

<style scoped>
.steward-inbox-notice {
  padding: 0.75rem 1.25rem;
  border-left: 3px solid var(--q-warning, #f2c037);
}
.notice-content {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.notice-icon {
  font-size: 1.3em;
  line-height: 1;
}
.notice-text {
  flex: 1;
}
.notice-headline {
  display: block;
  font-size: 0.9rem;
}
.notice-hint {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
  opacity: 0.85;
}
.notice-toggle {
  margin-top: 0.5rem;
  background: none;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0.1rem 0.5rem;
  cursor: pointer;
  font-size: 0.8rem;
  color: inherit;
}
.notice-affected {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.82rem;
}
.notice-affected-item {
  margin: 0.15rem 0;
  word-break: break-all;
}
</style>
