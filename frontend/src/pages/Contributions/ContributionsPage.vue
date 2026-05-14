<template>
  <div class="contributions-page">
    <!-- Page header -->
    <div class="page-header">
      <div class="page-header-text">
        <h2 class="page-title">Contributions</h2>
        <p class="page-subtitle">Track and manage community contribution work</p>
      </div>
      <button class="create-btn" @click="showCreateDialog = true">
        + New Contribution
      </button>
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
        <p v-if="activeStatusFilter !== 'all' || activeTypeFilter !== 'all'">
          Try adjusting your filters.
        </p>
        <p v-else>Create a contribution to start tracking work.</p>
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
    <ContributionForm
      v-model="showCreateDialog"
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
import type { CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';
import ContributionCard from 'src/components/contributions/ContributionCard.vue';
import ContributionForm from 'src/components/contributions/ContributionForm.vue';

const router = useRouter();
const $q = useQuasar();
const store = useContributionsStore();
const { createContribution, isSubmitting } = useContributions();

const showCreateDialog = ref(false);
const activeStatusFilter = ref('all');
const activeTypeFilter = ref('all');

// Suppress unused warning — isSubmitting is used in ContributionForm via composable
void isSubmitting;

const statusFilters = [
  { label: 'All', value: 'all' },
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

const OPEN_STATUSES = ['created', 'confirmed', 'shared', 'offered'];
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

  return list;
});

function loadContributions() {
  void store.fetchContributions();
}

onMounted(() => {
  loadContributions();
});

async function handleCreateSubmit(form: CreateContributionRequest | UpdateContributionRequest) {
  // On the list page we only ever open the form in create mode (no :contribution prop passed),
  // so the emitted form will always be a CreateContributionRequest.
  try {
    await createContribution(form as CreateContributionRequest);
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
  max-width: 900px;
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
  background: var(--matou-teal, #0d9488);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  &:hover { opacity: 0.9; }
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
  // No extra styles needed — ContributionCard handles its own margin
}
</style>
