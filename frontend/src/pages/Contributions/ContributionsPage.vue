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

    <!-- ── My Contributions ───────────────────────────────────── -->
    <section v-if="myContributions.length > 0" class="my-contributions-section">
      <div class="section-header">
        <h3 class="section-title">My Contributions</h3>
        <span class="section-count">{{ myContributions.length }}</span>
      </div>
      <div class="contributions-list">
        <ContributionCard
          v-for="contribution in myContributions"
          :key="contribution.id"
          :contribution="contribution"
          @click="router.push({ name: 'contribution-detail', params: { id: contribution.id } })"
        />
      </div>
    </section>

    <div v-if="myContributions.length > 0" class="section-divider">
      <h3 class="section-title">All Contributions</h3>
    </div>

    <!-- Filters -->
    <div class="filter-row">
      <div class="filter-group">
        <button
          v-for="f in statusFilters"
          :key="f.value"
          class="filter-pill"
          :class="{ active: activeStatusFilter === f.value }"
          @click="activeStatusFilter = f.value"
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
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Hammer } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import { useContributionsStore } from 'stores/contributions';
import { useContributions } from 'src/composables/useContributions';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { useIdentityStore } from 'stores/identity';
import type { CreateContributionRequest } from 'src/lib/api/contributions';
import ContributionCard from 'src/components/contributions/ContributionCard.vue';
import CreateContributionDialog from 'src/components/projects/CreateContributionDialog.vue';

const router = useRouter();
const $q = useQuasar();
const store = useContributionsStore();
const identityStore = useIdentityStore();
const { createContribution, isSubmitting } = useContributions();
const { isAdmin } = useAdminAccess();

const currentUserId = computed(() => identityStore.aidPrefix ?? '');

// "Mine" = contribution is offered to me OR assigned to me. Excludes archived.
// Sorted by due date (earliest first; missing deadlines last).
const myContributions = computed(() => {
  const me = currentUserId.value;
  if (!me) return [];
  const mine = store.contributions.filter((raw) => {
    const c = raw as typeof raw & { assigned_contributor?: string; offered_to?: string };
    if (c.status === 'archived') return false;
    const assigned = c.assigned_contributor_id ?? c.assigned_contributor;
    if (assigned === me) return true;
    if (c.offered_to === me) return true;
    return false;
  });
  return [...mine].sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
    const db = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ca - cb;
  });
});

const showCreateDialog = ref(false);
const activeStatusFilter = ref('open');
const activeTypeFilter = ref('all');

const statusFilters = [
  { label: 'Open', value: 'open' },
  { label: 'Assigned', value: 'in_progress' },
  { label: 'Needs Review', value: 'needs_review' },
  { label: 'Completed', value: 'completed' },
];

const typeFilters = [
  { label: 'Any Type', value: 'all' },
  { label: 'Governance', value: 'governance' },
  { label: 'Technical', value: 'technical' },
  { label: 'Cultural', value: 'cultural' },
  { label: 'Community', value: 'community' },
];

const OPEN_STATUSES = ['shared'];
const IN_PROGRESS_STATUSES = ['assigned', 'changed', 'in_progress'];
const NEEDS_REVIEW_STATUSES = ['needs_review'];
const COMPLETED_STATUSES = ['approved', 'signed_off', 'rewarded', 'completed'];

const filteredContributions = computed(() => {
  let list = store.contributions;

  // Status filter
  if (activeStatusFilter.value === 'open') {
    list = list.filter(c => OPEN_STATUSES.includes(c.status));
  } else if (activeStatusFilter.value === 'in_progress') {
    list = list.filter(c => IN_PROGRESS_STATUSES.includes(c.status));
  } else if (activeStatusFilter.value === 'needs_review') {
    list = list.filter(c => NEEDS_REVIEW_STATUSES.includes(c.status));
  } else if (activeStatusFilter.value === 'completed') {
    list = list.filter(c => COMPLETED_STATUSES.includes(c.status));
  }

  // Type filter
  if (activeTypeFilter.value !== 'all') {
    list = list.filter(c => c.contribution_type === activeTypeFilter.value);
  }

  // Default sort: earliest due date first; contributions without a deadline
  // fall to the bottom. Stable tie-breaker on created_at so repeated renders
  // don't shuffle.
  return [...list].sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
    const db = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ca - cb;
  });
});

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
</style>
