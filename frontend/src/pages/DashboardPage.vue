<template>
  <div class="dashboard-layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <!-- Logo Header -->
      <div class="sidebar-header">
        <div class="logo-container">
          <img src="../assets/images/matou-logo-teal.svg" alt="Matou" class="logo-icon" />
          <div class="logo-text">
            <span class="logo-title">Matou</span>
            <span class="logo-subtitle">Community</span>
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <nav class="sidebar-nav">
        <button class="nav-item active">
          <Home class="nav-icon" />
          <span>Home</span>
        </button>
        <button class="nav-item disabled" disabled>
          <Wallet class="nav-icon" />
          <span>Wallet</span>
        </button>
        <button class="nav-item disabled" disabled>
          <Target class="nav-icon" />
          <span>Contribute</span>
        </button>
        <button class="nav-item disabled" disabled>
          <Vote class="nav-icon" />
          <span>Proposals</span>
        </button>
        <button class="nav-item disabled" disabled>
          <MessageSquare class="nav-icon" />
          <span>Chat</span>
        </button>
      </nav>

      <!-- User Profile -->
      <div class="sidebar-footer">
        <div class="user-profile">
          <div class="user-avatar">
            <span>{{ userInitials }}</span>
          </div>
          <div class="user-info">
            <span class="user-name">{{ userName }}</span>
            <span class="user-action">View Profile</span>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <!-- Top Bar -->
      <!-- <header class="top-bar">

      </header> -->

      <!-- Welcome Header -->
      <section class="welcome-header">
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
              v-for="(stat, index) in notificationStats"
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

      <!-- Admin Section (conditional) -->
      <div v-if="isAdmin" class="admin-area px-6 mb-6">
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
          :error="pollingError"
          :action-error="actionError"
          @approve="handleApprove"
          @decline="handleDecline"
          @message="handleMessage"
          @refresh="handleRefresh"
          @retry="retryPolling"
        />
      </div>

      <!-- Content Grid -->
      <div class="content-area">
        <div class="content-grid">
          <!-- Left Column -->
          <div class="left-column">
            <!-- Membership Card -->
            <div class="card membership-card">
              <div class="card-row">
                <div class="membership-icon">
                  <Check class="check-icon" />
                </div>
                <div class="membership-info">
                  <h3 class="membership-title">Matou Member</h3>
                  <p class="membership-subtitle">Credential Active</p>
                </div>
                <span class="verified-badge">Verified</span>
              </div>
            </div>

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
                    <p>247 active members this week</p>
                  </div>
                </div>
                <div class="activity-item">
                  <div class="activity-icon bg-accent-light">
                    <Users class="icon text-accent" />
                  </div>
                  <div class="activity-info">
                    <h4>New Proposals</h4>
                    <p>5 governance proposals need your vote</p>
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
                <button
                  v-for="(member, index) in newMembers"
                  :key="index"
                  class="member-item"
                >
                  <div class="member-avatar" :class="member.colorClass">
                    <span>{{ member.initials }}</span>
                  </div>
                  <div class="member-info">
                    <h4>{{ member.name }}</h4>
                    <p>{{ member.joined }}</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Invite Member Modal -->
    <InviteMemberModal v-model="showInviteModal" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  Home,
  Wallet,
  Target,
  Vote,
  MessageSquare,
  Moon,
  Sun,
  Users,
  Shield,
  TrendingUp,
  Check,
  CoinsIcon,
  UserPlus,
} from 'lucide-vue-next';
import { useOnboardingStore } from 'stores/onboarding';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { useRegistrationPolling, type PendingRegistration } from 'src/composables/useRegistrationPolling';
import { useAdminActions } from 'src/composables/useAdminActions';
import AdminSection from 'src/components/admin/AdminSection.vue';
import InviteMemberModal from 'src/components/dashboard/InviteMemberModal.vue';

const store = useOnboardingStore();

// Admin functionality
const { isAdmin, checkAdminStatus } = useAdminAccess();
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
  error: actionError,
  approveRegistration,
  declineRegistration,
  sendMessageToApplicant,
  clearError,
} = useAdminActions();

const isRefreshing = ref(false);
const adminSectionRef = ref<InstanceType<typeof AdminSection> | null>(null);
const showInviteModal = ref(false);

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

  // Check if user is admin
  const adminStatus = await checkAdminStatus();
  if (adminStatus) {
    console.log('[Dashboard] User is admin, starting registration polling');
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

// User info
const userName = computed(() => {
  const name = store.profile.name || 'Alex Korero';
  return name;
});

const userInitials = computed(() => {
  const name = store.profile.name || 'Alex Korero';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

// Stats data - computed to show real pending registration count for admins
const notificationStats = computed(() => [
  {
    label: 'Pending Registrations',
    value: isAdmin.value ? pendingRegistrations.value.length : 0,
    icon: Users,
  },
  { label: 'New Transactions', value: 0, icon: CoinsIcon },
  { label: 'Proposal Updates', value: 0, icon: Vote },
  { label: 'Contribution Actions', value: 0, icon: Target },
]);

// New members data
const newMembers = [
  { name: 'Aroha Tamaki', joined: 'Joined 2 days ago', initials: 'AT', colorClass: 'gradient-1' },
  { name: 'Kai Whetu', joined: 'Joined 3 days ago', initials: 'KW', colorClass: 'gradient-2' },
  { name: 'Hine Moana', joined: 'Joined 5 days ago', initials: 'HM', colorClass: 'gradient-3' },
  { name: 'Tama Rangi', joined: 'Joined 1 week ago', initials: 'TR', colorClass: 'gradient-4' },
];

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

async function handleMessage(registration: PendingRegistration, message: string) {
  clearError();
  const success = await sendMessageToApplicant(registration, message);
  if (success) {
    adminSectionRef.value?.showSuccess(`Message sent to ${registration.profile.name}`);
  }
}

async function handleRefresh() {
  isRefreshing.value = true;
  await refreshRegistrations();
  isRefreshing.value = false;
}
</script>

<style lang="scss" scoped>
.dashboard-layout {
  display: flex;
  min-height: 100vh;
  background-color: var(--matou-background);
}

// Sidebar
.sidebar {
  width: 240px;
  background-color: var(--matou-sidebar);
  border-right: 1px solid var(--matou-sidebar-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 1.25rem 1rem;
  border-bottom: 1px solid var(--matou-sidebar-border);
}

.logo-container {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.logo-icon {
  width: 60px;
  height: 60px;
}

.logo-text {
  display: flex;
  flex-direction: column;
}

.logo-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--matou-sidebar-foreground);
}

.logo-subtitle {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
}

.sidebar-nav {
  flex: 1;
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--matou-radius);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-sidebar-foreground);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all 0.15s ease;

  &:hover:not(.disabled) {
    background-color: var(--matou-sidebar-accent);
  }

  &.active {
    background-color: var(--matou-sidebar-accent);
    color: var(--matou-sidebar-primary);
  }

  &.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.nav-icon {
  width: 18px;
  height: 18px;
}

.sidebar-footer {
  padding: 1rem;
  border-top: 1px solid var(--matou-sidebar-border);
}

.user-profile {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.user-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 0.8rem;
  font-weight: 600;
}

.user-info {
  display: flex;
  flex-direction: column;
}

.user-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-sidebar-foreground);
}

.user-action {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

// Main Content
.main-content {
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

// Membership Card
.membership-card {
  .card-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
}

.membership-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--matou-radius);
  background-color: var(--matou-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.check-icon {
  width: 20px;
  height: 20px;
  color: var(--matou-primary);
}

.membership-info {
  flex: 1;
}

.membership-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0;
}

.membership-subtitle {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin: 0.125rem 0 0;
}

.verified-badge {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-accent);
  background-color: rgba(74, 157, 156, 0.1);
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
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

// Responsive: Hide sidebar on small screens
@media (max-width: 767px) {
  .sidebar {
    display: none;
  }
}
</style>
