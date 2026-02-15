<template>
  <div class="dashboard-page">
    <!-- Welcome Header -->
    <section class="welcome-header rounded-b-3xl">
      <span class="greeting">Kia ora</span>
      <button class="theme-toggle" @click="toggleDarkMode" :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'">
        <Sun v-if="isDark" class="toggle-icon" />
        <Moon v-else class="toggle-icon" />
      </button>
      <div class="welcome-content">
        <div class="welcome-text">
          <h1 class="welcome-title">Welcome back</h1>
          <div class="moon-phase-display" v-if="moonData">
            <div class="moon-phase-header">
              <span class="moon-date">{{ formatDate(moonData.date) }}</span>
              <span class="moon-circle">{{ moonData.moon_circle }}</span>
              <span class="moon-name">{{ moonData.name }}</span>
            </div>
            <div class="moon-phase-details">
              <div class="moon-energy">
                <span class="energy-label">Energy:</span>
                <div class="energy-bars">
                  <div
                    class="energy-bar"
                    :class="{ active: moonData.energy === 'low' || moonData.energy === 'medium' || moonData.energy === 'high' }"
                  ></div>
                  <div
                    class="energy-bar"
                    :class="{ active: moonData.energy === 'medium' || moonData.energy === 'high' }"
                  ></div>
                  <div
                    class="energy-bar"
                    :class="{ active: moonData.energy === 'high' }"
                  ></div>
                </div>
                <span class="energy-text">{{ moonData.energy }}</span>
              </div>
              <p class="moon-description">{{ moonData.description }}</p>
            </div>
          </div>
          <div class="moon-phase-loading" v-else>
            Loading moon phase...
          </div>
        </div>
        <div class="stats-row">
          <button
            v-for="(stat, index) in notificationStats.filter(s => s.visible)"
            :key="index"
            class="stat-item"
          >
            <div class="stat-value">
              <component :is="stat.icon" class="stat-icon" />
              <span>{{ stat.value }}</span>
            </div>
            <span class="stat-label">{{ stat.label }}</span>
          </button>
        </div>
      </div>
    </section>

    <!-- Admin Section (conditional) - Only for Operations Steward or Community Steward -->
    <div v-if="isSteward" class="admin-area px-6 mb-6">
      <div class="admin-actions mb-4">
        <button
          class="invite-btn"
          @click="showInviteModal = true"
        >
          <UserPlus class="w-4 h-4" />
          Invite Member
        </button>
      </div>
      <AdminSection
        ref="adminSectionRef"
        :registrations="pendingRegistrations"
        :is-polling="isPolling"
        :is-refreshing="isRefreshing"
        :is-processing="isProcessing"
        :processing-registration-id="processingRegistrationId"
        :error="pollingError"
        :action-error="actionError"
        @approve="handleApprove"
        @decline="handleDecline"
        @refresh="handleRefresh"
        @retry="retryPolling"
      />
    </div>

    <!-- Content Grid -->
    <div class="content-area">
      <div class="content-grid">
        <!-- Left Column -->
        <div class="left-column">
          <!-- Community Activity -->
          <div class="card community-card">
            <h3 class="card-title">Community Activity</h3>
            <div class="activity-list">
              <div class="activity-item">
                <div class="activity-icon bg-primary-light">
                  <TrendingUp class="icon text-primary" />
                </div>
                <div class="activity-info">
                  <h4>Growing Together</h4>
                  <p>{{ newMembersThisWeek }} new {{ newMembersThisWeek === 1 ? 'member' : 'members' }} this week</p>
                </div>
              </div>
              <div class="activity-item">
                <div class="activity-icon bg-accent-light">
                  <Users class="icon text-accent" />
                </div>
                <div class="activity-info">
                  <h4>Monthly Growth</h4>
                  <p>{{ newMembersThisMonth }} new {{ newMembersThisMonth === 1 ? 'member' : 'members' }} this month</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column -->
        <div class="right-column">
          <!-- New Members -->
          <div class="card members-card">
            <h3 class="card-title">New Members</h3>
            <div class="members-list">
              <ProfileCard
                v-for="(member, index) in liveMembers"
                :key="index"
                :profile="member.profile"
                :communityProfile="member.communityProfile"
                @click="handleMemberClick(member)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Invite Member Modal -->
    <InviteMemberModal v-model="showInviteModal" />

    <!-- Member Profile Dialog -->
    <Teleport to="body">
      <MemberProfileDialog
        v-if="selectedMember"
        :sharedProfile="selectedMember.shared"
        :communityProfile="selectedMember.community"
        @close="selectedMember = null"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  Moon,
  Sun,
  Users,
  TrendingUp,
  CoinsIcon,
  Vote,
  Target,
  UserPlus,
} from 'lucide-vue-next';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { useRegistrationPolling, type PendingRegistration } from 'src/composables/useRegistrationPolling';
import { useAdminActions } from 'src/composables/useAdminActions';
import { useProfilesStore } from 'stores/profiles';
import AdminSection from 'src/components/admin/AdminSection.vue';
import InviteMemberModal from 'src/components/dashboard/InviteMemberModal.vue';
import ProfileCard from 'src/components/profiles/ProfileCard.vue';
import MemberProfileDialog from 'src/components/profiles/MemberProfileDialog.vue';

// Admin functionality
const { isSteward, checkAdminStatus } = useAdminAccess();
const {
  pendingRegistrations,
  isPolling,
  error: pollingError,
  startPolling,
  stopPolling,
  refresh: refreshRegistrations,
  removeRegistration,
  retry: retryPolling,
} = useRegistrationPolling({ pollingInterval: 10000 });
const {
  isProcessing,
  processingRegistrationId,
  error: actionError,
  approveRegistration,
  declineRegistration,
  clearError,
} = useAdminActions();

const profilesStore = useProfilesStore();

const isRefreshing = ref(false);
const adminSectionRef = ref<InstanceType<typeof AdminSection> | null>(null);
const showInviteModal = ref(false);
const selectedMember = ref<{ shared?: Record<string, unknown>; community?: Record<string, unknown> } | null>(null);

// Dark mode state
const isDark = ref(false);

// Moon phase data
interface MoonData {
  date: string;
  lunar_day: number;
  name: string;
  energy: 'low' | 'medium' | 'high';
  description: string;
  moon_circle: string;
}

const moonData = ref<MoonData | null>(null);

// Fetch moon phase data
async function fetchMoonPhase() {
  try {
    const response = await fetch('https://maramataka-api.matou.nz/');
    if (response.ok) {
      const data = await response.json();
      moonData.value = data;
    } else {
      console.error('Failed to fetch moon phase data');
    }
  } catch (error) {
    console.error('Error fetching moon phase:', error);
  }
}

// Format date for display
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

onMounted(async () => {
  isDark.value = document.documentElement.classList.contains('dark');

  // Fetch moon phase data
  await fetchMoonPhase();

  // Check if user is admin/steward
  await checkAdminStatus();
  if (isSteward.value) {
    console.log('[Dashboard] User is steward, starting registration polling');
    startPolling();
  }
});

onUnmounted(() => {
  stopPolling();
});

const toggleDarkMode = () => {
  isDark.value = !isDark.value;
  document.documentElement.classList.toggle('dark', isDark.value);
};

// Stats data - computed to show real pending registration count for stewards only
const notificationStats = computed(() => [
  {
    label: 'Pending Registrations',
    value: isSteward.value ? pendingRegistrations.value.length : 0,
    icon: Users,
    visible: isSteward.value,
  },
  { label: 'New Transactions', value: 0, icon: CoinsIcon, visible: true },
  { label: 'Proposal Updates', value: 0, icon: Vote, visible: true },
  { label: 'Contribution Actions', value: 0, icon: Target, visible: true },
]);

// Live member data from profiles store (with fallback to static data)
const liveMembers = computed(() => {
  const shared = profilesStore.communityProfiles;
  if (shared.length > 0) {
    return shared.map(p => ({
      profile: (p.data as Record<string, unknown>) || p,
      communityProfile: findCommunityProfile(p),
    }));
  }
  return [];
});

// Calculate new members this week
const newMembersThisWeek = computed(() => {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  return profilesStore.communityReadOnlyProfiles.filter(p => {
    const data = (p.data as Record<string, unknown>) || {};
    const memberSince = data.memberSince as string;
    if (!memberSince) return false;
    const joinDate = new Date(memberSince);
    return joinDate >= startOfWeek;
  }).length;
});

// Calculate new members this month
const newMembersThisMonth = computed(() => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return profilesStore.communityReadOnlyProfiles.filter(p => {
    const data = (p.data as Record<string, unknown>) || {};
    const memberSince = data.memberSince as string;
    if (!memberSince) return false;
    const joinDate = new Date(memberSince);
    return joinDate >= startOfMonth;
  }).length;
});

function findCommunityProfile(sharedProfile: Record<string, unknown>): Record<string, unknown> | undefined {
  const aid = ((sharedProfile.data as Record<string, unknown>)?.aid || sharedProfile.id) as string;
  if (!aid) return undefined;
  const cp = profilesStore.communityReadOnlyProfiles.find(p => {
    const data = (p.data as Record<string, unknown>) || {};
    return data.userAID === aid ||
           (p.id as string)?.includes(aid);
  });
  return cp ? ((cp.data as Record<string, unknown>) || cp) : undefined;
}

function handleMemberClick(member: { profile: Record<string, unknown>; communityProfile?: Record<string, unknown> }) {
  selectedMember.value = { shared: member.profile, community: member.communityProfile };
}

// Admin action handlers
async function handleApprove(registration: PendingRegistration) {
  clearError();
  const success = await approveRegistration(registration);
  if (success) {
    removeRegistration(registration.notificationId);
    adminSectionRef.value?.showSuccess(`Approved ${registration.profile.name}`);
  }
}

async function handleDecline(registration: PendingRegistration, reason?: string) {
  clearError();
  const success = await declineRegistration(registration, reason);
  if (success) {
    removeRegistration(registration.notificationId);
    adminSectionRef.value?.showSuccess(`Declined ${registration.profile.name}`);
  }
}

async function handleRefresh() {
  isRefreshing.value = true;
  await refreshRegistrations();
  isRefreshing.value = false;
}
</script>

<style lang="scss" scoped>
// Dashboard Page
.dashboard-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  background-color: var(--matou-card);
  border-bottom: 1px solid var(--matou-border);
}

.greeting {
  font-size: 0.875rem;
  color: white
}

.theme-toggle {
  padding: 0.5rem;
  border-radius: var(--matou-radius);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
    color: var(--matou-foreground);
  }
}

.toggle-icon {
  width: 18px;
  height: 18px;
}

// Welcome Header
.welcome-header {
  background: linear-gradient(135deg, var(--matou-primary), rgba(30, 95, 116, 0.9), var(--matou-accent));
  padding: 2rem 1.5rem;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;

  @media (min-width: 768px) {
    flex-direction: row;
    align-items: flex-end;
    justify-content: space-between;
  }
}

.welcome-title {
  font-size: 2rem;
  font-weight: 600;
  color: white;
  margin: 0;
}

.member-since {
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.8);
  margin-top: 0.25rem;
}

// Moon Phase Display
.moon-phase-display {
  margin-top: 0.75rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: var(--matou-radius);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.moon-phase-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.moon-date {
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
}

.moon-circle {
  font-size: 1.5rem;
  line-height: 1;
}

.moon-name {
  font-size: 1rem;
  color: rgba(255, 255, 255, 0.95);
  font-weight: 600;
}

.moon-phase-details {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1;
  min-width: 200px;
}

.moon-energy {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.energy-label {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.8);
  font-weight: 500;
}

.energy-bars {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.energy-bar {
  width: 20px;
  height: 6px;
  border-radius: 3px;
  background-color: rgba(255, 255, 255, 0.2);
  transition: all 0.2s ease;

  &.active {
    background-color: rgba(255, 255, 255, 0.9);
  }
}

.energy-text {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.8);
  text-transform: capitalize;
  font-weight: 500;
}

.moon-description {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.85);
  margin: 0;
  line-height: 1.4;
  font-style: italic;
}

.moon-phase-loading {
  margin-top: 0.75rem;
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.7);
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;

  @media (min-width: 768px) {
    grid-template-columns: repeat(4, 1fr);
  }
}

.stat-item {
  background: transparent;
  border: none;
  padding: 0.75rem;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    .stat-value,
    .stat-label {
      filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.8));
    }
  }
}

.stat-value {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: rgba(255, 255, 255, 0.9);
  font-size: 1.25rem;
  font-weight: 600;
  transition: filter 0.15s ease;
}

.stat-icon {
  width: 16px;
  height: 16px;
}

.stat-label {
  display: block;
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.25rem;
  line-height: 1.3;
  transition: all 0.15s ease;
}

// Admin Area
.admin-area {
  margin-top: 1.5rem;
}

.admin-actions {
  display: flex;
  gap: 0.75rem;
}

.invite-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background-color: var(--matou-primary);
  color: white;
  border: none;
  border-radius: var(--matou-radius);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    opacity: 0.9;
  }
}

// Content Area
.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}

.content-grid {
  display: grid;
  gap: 1.5rem;

  @media (min-width: 768px) {
    grid-template-columns: 1fr 1fr;
  }
}

.left-column,
.right-column {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

// Cards
.card {
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-xl);
  padding: 1rem;
  transition: box-shadow 0.2s ease;

  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  }
}

.card-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0 0 0.75rem 0;
}

// Community Card
.community-card {
  padding: 1rem 1.25rem;
}

.activity-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.activity-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--matou-radius);
  display: flex;
  align-items: center;
  justify-content: center;

  &.bg-primary-light {
    background-color: rgba(30, 95, 116, 0.1);
  }

  &.bg-accent-light {
    background-color: rgba(74, 157, 156, 0.1);
  }

  .icon {
    width: 16px;
    height: 16px;

    &.text-primary {
      color: var(--matou-primary);
    }

    &.text-accent {
      color: var(--matou-accent);
    }
  }
}

.activity-info {
  flex: 1;

  h4 {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--matou-foreground);
    margin: 0;
  }

  p {
    font-size: 0.8rem;
    color: var(--matou-muted-foreground);
    margin: 0.125rem 0 0;
  }
}

// Members Card
.members-card {
  padding: 1rem 1.25rem;
}

.members-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  width: 100%;

  &:hover h4 {
    text-decoration: underline;
  }
}

.member-avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--matou-radius);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  span {
    font-size: 0.95rem;
    font-weight: 700;
    color: white;
  }

  &.gradient-1 {
    background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  }

  &.gradient-2 {
    background: linear-gradient(135deg, var(--matou-accent), var(--matou-chart-2));
  }

  &.gradient-3 {
    background: linear-gradient(135deg, var(--matou-chart-2), var(--matou-primary));
  }

  &.gradient-4 {
    background: linear-gradient(135deg, rgba(30, 95, 116, 0.8), rgba(74, 157, 156, 0.8));
  }
}

.member-info {
  flex: 1;

  h4 {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--matou-foreground);
    margin: 0;
    transition: text-decoration 0.15s ease;
  }

  p {
    font-size: 0.8rem;
    color: var(--matou-muted-foreground);
    margin: 0.125rem 0 0;
  }
}
</style>
