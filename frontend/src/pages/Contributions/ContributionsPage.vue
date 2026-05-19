<template>
  <div class="contributions-page">
    <!-- Page header -->
    <div class="page-header">
      <div class="page-header-text">
        <h2 class="page-title">Contributions</h2>
        <p class="page-subtitle">Track and manage community contribution work</p>
      </div>
      <button v-if="isAdmin" class="create-btn" @click="showCreateDialog = true">
        + New Contribution
      </button>
    </div>

    <!-- View mode toggle -->
    <div class="view-mode-row">
      <q-btn-toggle
        v-model="viewMode"
        no-caps
        spread
        toggle-color="primary"
        color="white"
        text-color="primary"
        :options="[
          { label: 'Timeline', value: 'timeline', icon: 'view_timeline' },
          { label: 'List', value: 'list', icon: 'view_list' },
        ]"
        class="view-mode-toggle"
      />
    </div>

    <!-- Filters (apply to both list and timeline) -->
    <div class="filter-row">
      <div class="filter-group">
        <button
          v-for="f in scopeFilters"
          :key="f.value"
          class="filter-pill"
          :class="{ active: activeScopeFilter === f.value }"
          @click="activeScopeFilter = f.value"
        >
          {{ f.label }}
        </button>
      </div>

      <div class="filter-group">
        <button
          v-for="f in typeFilters"
          :key="f.value"
          class="filter-pill type-pill"
          :class="{ active: activeTypeFilter === f.value }"
          @click="activeTypeFilter = f.value"
        >
          {{ f.label }}
        </button>
      </div>
    </div>

    <template v-if="viewMode === 'list'">
      <!-- Content -->
      <div class="feed-container">
        <div v-if="store.isLoading" class="loading-state">
          <q-spinner-dots size="40px" color="primary" />
        </div>

        <div v-else-if="store.error" class="empty-state">
          <q-icon name="error_outline" size="48px" class="empty-icon" color="negative" />
          <h3>Failed to load contributions</h3>
          <p>{{ store.error }}</p>
          <q-btn flat no-caps label="Retry" color="primary" @click="loadContributions" />
        </div>

        <div v-else-if="filteredContributions.length === 0" class="empty-state">
          <Hammer :size="48" class="empty-icon" />
          <h3>No contributions found</h3>
          <p>Try adjusting your filters.</p>
        </div>

        <div v-else class="contributions-list">
          <ContributionCard
            v-for="contribution in filteredContributions"
            :key="contribution.id"
            :contribution="contribution"
            @click="router.push({ name: 'contribution-detail', params: { id: contribution.id } })"
          />
        </div>
      </div>
    </template>

    <template v-else>
      <ContributionsTimelineView
        :contributions="filteredContributions"
        @view-contribution="handleViewContribution"
      />
    </template>

    <!-- Create Contribution Dialog -->
    <CreateContributionDialog
      v-model="showCreateDialog"
      standalone
      :is-submitting="isSubmitting"
      @submit="handleCreateSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Hammer } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import { useContributionsStore } from 'stores/contributions';
import { useContributions } from 'src/composables/useContributions';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { useIdentityStore } from 'stores/identity';
import type { Contribution, CreateContributionRequest } from 'src/lib/api/contributions';
import ContributionCard from 'src/components/contributions/ContributionCard.vue';
import CreateContributionDialog from 'src/components/projects/CreateContributionDialog.vue';
import ContributionsTimelineView from 'src/pages/Contributions/ContributionsTimelineView.vue';

const router = useRouter();
const $q = useQuasar();
const store = useContributionsStore();
const identityStore = useIdentityStore();
const { createContribution, isSubmitting } = useContributions();
const { isAdmin } = useAdminAccess();

const currentUserId = computed(() => identityStore.aidPrefix ?? '');

const showCreateDialog = ref(false);
const activeTypeFilter = ref('all');

const VIEW_MODE_STORAGE_KEY = 'matou:contributions:view';
const storedViewMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
const viewMode = ref<'list' | 'timeline'>(
  storedViewMode === 'list' ? 'list' : 'timeline',
);

watch(viewMode, (v) => {
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
});

const SCOPE_STORAGE_KEY = 'matou:contributions:scope';
type ScopeFilter = 'all' | 'mine' | 'open' | 'assigned' | 'in_review' | 'signed_off' | 'archived';
const storedScope = localStorage.getItem(SCOPE_STORAGE_KEY) as ScopeFilter | null;
const validScopes: ScopeFilter[] = ['all', 'mine', 'open', 'assigned', 'in_review', 'signed_off', 'archived'];
const activeScopeFilter = ref<ScopeFilter>(
  storedScope && validScopes.includes(storedScope) ? storedScope : 'all',
);
watch(activeScopeFilter, (v) => {
  localStorage.setItem(SCOPE_STORAGE_KEY, v);
});

const scopeFilters: { label: string; value: ScopeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Mine', value: 'mine' },
  { label: 'Open', value: 'open' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Review', value: 'in_review' },
  { label: 'Signed Off', value: 'signed_off' },
  { label: 'Archived', value: 'archived' },
];

const typeFilters = [
  { label: 'Any Type', value: 'all' },
  { label: 'Governance', value: 'governance' },
  { label: 'Technical', value: 'technical' },
  { label: 'Cultural', value: 'cultural' },
  { label: 'Community', value: 'community' },
];

const ASSIGNED_STATUSES = new Set(['assigned', 'changed', 'in_progress']);
const SIGNED_OFF_STATUSES = new Set(['signed_off', 'rewarded']);

function isMineContribution(c: Contribution, me: string): boolean {
  const raw = c as typeof c & { assigned_contributor?: string; offered_to?: string };
  const assigned = raw.assigned_contributor_id ?? raw.assigned_contributor;
  if (assigned === me) return true;
  if (raw.offered_to === me) return true;
  return false;
}

const filteredContributions = computed(() => {
  const me = currentUserId.value;
  let list: Contribution[] = store.contributions;

  switch (activeScopeFilter.value) {
    case 'mine':
      // Assigned to me OR offered to me. Excludes archived.
      list = list.filter((c) => c.status !== 'archived' && me && isMineContribution(c, me));
      break;
    case 'all': {
      // Hide planning ('confirmed'), hide private offers to other users,
      // and hide archived (archived has its own chip).
      list = list.filter((c) => {
        if (c.status === 'archived') return false;
        if (c.status === 'confirmed') return false;
        const raw = c as typeof c & { offered_to?: string };
        if (c.status === 'offered' && raw.offered_to && raw.offered_to !== me) return false;
        return true;
      });
      break;
    }
    case 'open':
      list = list.filter((c) => c.status === 'shared');
      break;
    case 'assigned':
      list = list.filter((c) => ASSIGNED_STATUSES.has(c.status));
      break;
    case 'in_review':
      list = list.filter((c) => c.status === 'needs_review');
      break;
    case 'signed_off':
      list = list.filter((c) => SIGNED_OFF_STATUSES.has(c.status));
      break;
    case 'archived':
      list = list.filter((c) => c.status === 'archived');
      break;
  }

  if (activeTypeFilter.value !== 'all') {
    list = list.filter((c) => c.contribution_type === activeTypeFilter.value);
  }

  // Default sort: earliest due date first; missing deadlines fall to the
  // bottom. Stable tie-breaker on created_at.
  return [...list].sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
    const db = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ca - cb;
  });
});

function handleViewContribution(c: Contribution) {
  void router.push({ name: 'contribution-detail', params: { id: c.id } });
}

function loadContributions() {
  void store.fetchContributions();
}

onMounted(() => {
  loadContributions();
});

async function handleCreateSubmit(form: CreateContributionRequest) {
  try {
    await createContribution(form);
    showCreateDialog.value = false;
    $q.notify({ type: 'positive', message: 'Contribution created!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to create contribution' });
  }
}
</script>

<style scoped lang="scss">
.contributions-page {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
}

.page-subtitle {
  color: var(--matou-muted-foreground);
  margin: 4px 0 0;
}

.create-btn {
  background: transparent;
  color: var(--matou-teal, #0d9488);
  border: 2px solid var(--matou-teal, #0d9488);
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;

  &:hover {
    background: var(--matou-teal, #0d9488);
    color: white;
  }
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.filter-pill {
  background: transparent;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 20px;
  padding: 5px 12px;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &.active {
    background: var(--matou-primary);
    color: white;
    border-color: var(--matou-primary);
  }

  &.type-pill.active {
    background: var(--matou-accent, #4a9d9c);
    border-color: var(--matou-accent, #4a9d9c);
  }

  &:hover:not(.active) {
    border-color: var(--matou-primary);
    color: var(--matou-primary);
  }
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.contributions-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;

  :deep(.contribution-card) {
    margin-bottom: 0;
  }
}

@media (max-width: 1000px) {
  .contributions-list {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .contributions-list {
    grid-template-columns: 1fr;
  }
}

.my-contributions-section {
  margin-bottom: 24px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.section-count {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  background: var(--matou-secondary);
  padding: 2px 10px;
  border-radius: 12px;
}

.section-divider {
  margin: 8px 0 12px;
}

.view-mode-row {
  display: flex;
  justify-content: flex-start;
  margin: 0 0 16px;
}

.view-mode-toggle {
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  overflow: hidden;

  :deep(.q-btn) {
    min-width: 140px;
    padding: 8px 24px;
  }
}
</style>
