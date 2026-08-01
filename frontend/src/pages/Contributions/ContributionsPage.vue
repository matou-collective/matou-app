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

    <!-- View mode toggle + sort / search toolbar -->
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

      <div class="toolbar-controls">
        <q-input
          v-model="searchQuery"
          dense
          outlined
          clearable
          debounce="200"
          placeholder="Search contributions"
          class="search-input"
        >
          <template #prepend>
            <q-icon name="search" />
          </template>
        </q-input>

        <q-btn-dropdown
          no-caps
          outline
          color="primary"
          icon="sort"
          :label="activeSortLabel"
          class="sort-dropdown"
        >
          <q-list>
            <q-item
              v-for="s in sortFields"
              :key="s.value"
              v-close-popup
              clickable
              :active="sortField === s.value"
              @click="sortField = s.value"
            >
              <q-item-section>{{ s.label }}</q-item-section>
              <q-item-section v-if="sortField === s.value" side>
                <q-icon name="check" color="primary" />
              </q-item-section>
            </q-item>
          </q-list>
        </q-btn-dropdown>

        <q-btn
          outline
          color="primary"
          :icon="sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'"
          :title="sortDirection === 'asc' ? 'Ascending' : 'Descending'"
          class="sort-direction-btn"
          @click="toggleSortDirection"
        />
      </div>
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
import {
  applyContributionsView,
  SCOPE_FILTERS,
  TYPE_FILTERS,
  SORT_FIELDS,
  type ScopeFilter,
  type SortField,
  type SortDirection,
} from 'src/lib/contributionsView';
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
const storedScope = localStorage.getItem(SCOPE_STORAGE_KEY) as ScopeFilter | null;
const validScopes: ScopeFilter[] = SCOPE_FILTERS.map((f) => f.value);
const activeScopeFilter = ref<ScopeFilter>(
  storedScope && validScopes.includes(storedScope) ? storedScope : 'all',
);
watch(activeScopeFilter, (v) => {
  localStorage.setItem(SCOPE_STORAGE_KEY, v);
});

const scopeFilters = SCOPE_FILTERS;
const typeFilters = TYPE_FILTERS;
const sortFields = SORT_FIELDS;

// Free-text search over title and description.
const searchQuery = ref('');

// User-selectable sort (field + direction), persisted like the other controls.
const SORT_FIELD_STORAGE_KEY = 'matou:contributions:sortField';
const SORT_DIR_STORAGE_KEY = 'matou:contributions:sortDir';
const validSortFields: SortField[] = SORT_FIELDS.map((f) => f.value);
const storedSortField = localStorage.getItem(SORT_FIELD_STORAGE_KEY) as SortField | null;
const storedSortDir = localStorage.getItem(SORT_DIR_STORAGE_KEY) as SortDirection | null;
const sortField = ref<SortField>(
  storedSortField && validSortFields.includes(storedSortField) ? storedSortField : 'deadline',
);
const sortDirection = ref<SortDirection>(storedSortDir === 'desc' ? 'desc' : 'asc');
watch(sortField, (v) => localStorage.setItem(SORT_FIELD_STORAGE_KEY, v));
watch(sortDirection, (v) => localStorage.setItem(SORT_DIR_STORAGE_KEY, v));

const activeSortLabel = computed(
  () => SORT_FIELDS.find((f) => f.value === sortField.value)?.label ?? 'Sort',
);

function toggleSortDirection() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
}

const filteredContributions = computed(() =>
  applyContributionsView(store.contributions, {
    scope: activeScopeFilter.value,
    type: activeTypeFilter.value,
    search: searchQuery.value ?? '',
    sortField: sortField.value,
    sortDirection: sortDirection.value,
    currentUserId: currentUserId.value,
  }),
);

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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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

.toolbar-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.search-input {
  min-width: 220px;
}

.sort-dropdown,
.sort-direction-btn {
  height: 40px;
}
</style>
