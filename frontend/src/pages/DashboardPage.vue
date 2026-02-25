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

    <!-- Content Grid -->
    <div class="content-area">
      <div class="content-grid">
        <!-- Left Column -->
        <div class="left-column">
          <!-- Community Activity -->
          <div class="card community-card">
            <div class="community-header">
              <h3 class="card-title">Community Activity</h3>
              <button class="refresh-btn" @click="refreshActivity" :disabled="refreshingActivity">
                <RotateCw class="refresh-icon" :class="{ spinning: refreshingActivity }" />
              </button>
            </div>
            <div class="community-stats">
              <div class="community-stat">
                <Users class="community-stat-icon" />
                <span class="community-stat-value">{{ liveMembers.length }}</span>
                <span class="community-stat-label">Members</span>
              </div>
              <div class="community-stat">
                <MessageCircle class="community-stat-icon" />
                <span class="community-stat-value">{{ totalChannels }}</span>
                <span class="community-stat-label">Channels</span>
              </div>
              <div class="community-stat">
                <CalendarDays class="community-stat-icon" />
                <span class="community-stat-value">{{ totalEvents }}</span>
                <span class="community-stat-label">Events</span>
              </div>
              <div class="community-stat">
                <Megaphone class="community-stat-icon" />
                <span class="community-stat-value">{{ totalAnnouncements }}</span>
                <span class="community-stat-label">Announcements</span>
              </div>
              <div class="community-stat">
                <RefreshCw class="community-stat-icon" />
                <span class="community-stat-value">{{ totalUpdates }}</span>
                <span class="community-stat-label">Updates</span>
              </div>
            </div>
            <div class="activity-list">
              <div v-if="activityFeed.length === 0" class="activity-empty">
                No recent activity
              </div>
              <div
                v-for="item in activityFeed"
                :key="item.key"
                class="activity-item clickable"
                @click="handleFeedClick(item)"
              >
                <div class="activity-icon" :class="item.iconBg">
                  <component :is="item.icon" class="icon" :class="item.iconColor" />
                </div>
                <div class="activity-info">
                  <h4>{{ item.title }}</h4>
                  <p>{{ item.timeAgo }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column -->
        <div class="right-column">
          <div class="card members-card">
            <div class="members-header">
              <h3 class="card-title" v-if="pendingMembers.length > 0">Pending</h3>
              <h3 class="card-title" v-else>Members</h3>
              <button
                class="invite-btn"
                @click="showInviteModal = true"
              >
                <UserPlus class="w-4 h-4" />
                Invite Member
              </button>
            </div>
            <template v-if="pendingMembers.length > 0">
              <div class="members-list">
                <ProfileCard
                  v-for="(member, index) in pendingMembers"
                  :key="'pending-' + index"
                  :profile="member.profile"
                  :communityProfile="member.communityProfile"
                  :adminAids="adminAids"
                  @click="handleMemberClick(member)"
                />
              </div>
            </template>

            <h3 v-if="pendingMembers.length > 0" class="card-title" style="padding-top: 1rem">Members</h3>
            <div class="members-list">
              <ProfileCard
                v-for="(member, index) in liveMembers"
                :key="'member-' + index"
                :profile="member.profile"
                :communityProfile="member.communityProfile"
                :adminAids="adminAids"
                @click="handleMemberClick(member)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Invite Member Modal -->
    <InviteMemberModal v-model="showInviteModal" :isSteward="isSteward" />

    <!-- Member Profile Dialog -->
    <ProfileModal
      :show="!!selectedMember"
      :sharedProfile="selectedMemberSharedProfile"
      :communityProfile="selectedMemberCommunityProfile"
      :registration="selectedMemberRegistration"
      :isProcessing="isProcessing"
      :error="actionError || endorseError || attendanceError"
      :isSteward="isSteward"
      :currentUserAid="identityStore.currentAID?.prefix || ''"
      :endorsements="selectedMemberEndorsements"
      :hasEndorsed="selectedMemberHasEndorsed"
      :isEndorsing="isEndorsing"
      :hasMarkedAttended="selectedMemberHasAttended"
      :isMarkingAttended="isMarkingAttended"
      :canChangeRole="false /* TODO: disabled pending multisig rotation fix — see docs/multisig-rotation-report.md */"
      @close="handleCloseModal"
      @approve="handleApprove"
      @decline="handleDecline"
      @endorse="handleEndorse"
      @mark-attended="handleMarkAttended"
      @role-updated="handleRoleUpdated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  Moon,
  Sun,
  Users,
  TrendingUp,
  CoinsIcon,
  Vote,
  Target,
  UserPlus,
  UserRoundPlus,
  MessageCircle,
  CalendarDays,
  Megaphone,
  RefreshCw,
  RotateCw,
} from 'lucide-vue-next';
import { useBackendEvents } from 'src/composables/useBackendEvents';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { fetchOrgConfig } from 'src/api/config';
import { useRegistrationPolling, type PendingRegistration } from 'src/composables/useRegistrationPolling';
import { useAdminActions } from 'src/composables/useAdminActions';
import { useMultisigJoin } from 'src/composables/useMultisigJoin';
import { useEndorsements } from 'src/composables/useEndorsements';
import { useEventAttendance } from 'src/composables/useEventAttendance';
import { useProfilesStore } from 'stores/profiles';
import { useIdentityStore } from 'stores/identity';
import { useActivityStore } from 'stores/activity';
import { useChatStore } from 'stores/chat';
import InviteMemberModal from 'src/components/dashboard/InviteMemberModal.vue';
import ProfileCard from 'src/components/profiles/ProfileCard.vue';
import ProfileModal from 'src/components/profiles/ProfileModal.vue';

// Admin functionality
const { isSteward, canManageMembers, checkAdminStatus } = useAdminAccess();
const {
  pendingRegistrations,
  startPolling,
  stopPolling,
  removeRegistration,
} = useRegistrationPolling({ pollingInterval: 10000 });
const {
  isProcessing,
  error: actionError,
  approveRegistration,
  declineRegistration,
  clearError,
} = useAdminActions();

const {
  hasJoined: hasJoinedMultisig,
  startPolling: startMultisigPolling,
  stopPolling: stopMultisigPolling,
} = useMultisigJoin();

const {
  isEndorsing,
  error: endorseError,
  endorseApplicant,
  hasEndorsed,
  getEndorsements,
  loadIssuedEndorsements,
  clearError: clearEndorseError,
} = useEndorsements();

const {
  isMarking: isMarkingAttended,
  error: attendanceError,
  markAttended,
  hasMarkedAttended,
  clearError: clearAttendanceError,
} = useEventAttendance();

const identityStore = useIdentityStore();

const profilesStore = useProfilesStore();

const activityStore = useActivityStore();
const chatStore = useChatStore();
const router = useRouter();

const { lastEvent } = useBackendEvents();

// Track recent profile creation events from SSE
interface ProfileEvent {
  displayName: string;
  timestamp: Date;
}
const recentProfileEvents = ref<ProfileEvent[]>([]);

watch(lastEvent, (event) => {
  if (event?.type === 'profile:updated' && event.data?.displayName) {
    recentProfileEvents.value.unshift({
      displayName: event.data.displayName,
      timestamp: new Date(),
    });
    // Keep only last 10
    if (recentProfileEvents.value.length > 10) {
      recentProfileEvents.value.length = 10;
    }
  }
});

const adminAids = ref<string[]>([]);
const showInviteModal = ref(false);
const refreshingActivity = ref(false);

async function refreshActivity() {
  refreshingActivity.value = true;
  try {
    await Promise.all([
      activityStore.loadNotices(),
      chatStore.loadChannels(),
    ]);
  } finally {
    refreshingActivity.value = false;
  }
}
const selectedMember = ref<{ shared?: Record<string, unknown>; community?: Record<string, unknown> } | null>(null);

// Reactively track the selected member's SharedProfile from the store.
// Without this, the sharedProfile prop passed to ProfileModal is a stale
// snapshot captured at click-time and never sees attendanceRecord updates.
const selectedMemberSharedProfile = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return selectedMember.value?.shared;
  const fresh = profilesStore.communityProfiles.find(p => {
    const data = (p.data as Record<string, unknown>) || {};
    return data.aid === aid || (p.id as string)?.includes(aid);
  });
  if (fresh) return (fresh.data as Record<string, unknown>) || fresh;
  return selectedMember.value?.shared;
});

// Reactively track the selected member's CommunityProfile from the store.
// Without this, the communityProfile prop is a stale snapshot that may not
// have loaded yet when the modal first opens (CommunityProfile syncs async).
const selectedMemberCommunityProfile = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return selectedMember.value?.community;
  return findCommunityProfile({ data: { aid } } as Record<string, unknown>) || selectedMember.value?.community;
});

// Find matching PendingRegistration for the selected member (enables approve/decline buttons)
const selectedMemberRegistration = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return null;
  return pendingRegistrations.value.find(r => r.applicantAid === aid) || null;
});

const selectedMemberEndorsements = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return [];
  return getEndorsements(aid);
});

const selectedMemberHasEndorsed = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return false;
  return hasEndorsed(aid);
});

// Reload issued endorsements from KERIA when a member is selected.
// The onMounted load may have run before any endorsements were issued
// (e.g. the invite flow issues credentials after the dashboard mounts).
watch(selectedMember, (member) => {
  if (member) {
    loadIssuedEndorsements();
  }
});

const selectedMemberHasAttended = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return false;
  return hasMarkedAttended(aid);
});

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

  // Poll for multisig rotation notifications (e.g., after being promoted to steward)
  startMultisigPolling(5000);

  // Fetch admin AIDs for endorsement badge distinction
  try {
    const configResult = await fetchOrgConfig();
    const config = configResult.status === 'configured'
      ? configResult.config
      : configResult.status === 'server_unreachable'
        ? configResult.cached
        : null;
    if (config?.admins) {
      adminAids.value = config.admins.map((a: { aid: string }) => a.aid);
    }
  } catch { /* non-fatal */ }

  // Load endorsement credentials issued by this user from KERIA.
  // Covers endorsements issued outside useEndorsements (e.g. invite flow).
  await loadIssuedEndorsements();

  // Only poll for pending registrations if the user is a steward/admin
  if (isSteward.value) {
    startPolling();
  }

  // Load activity and chat data for community stats
  activityStore.loadNotices();
  chatStore.loadChannels();
});

onUnmounted(() => {
  stopPolling();
  stopMultisigPolling();
});

watch(hasJoinedMultisig, async (joined) => {
  if (joined) {
    console.log('[Dashboard] Joined org multisig, re-checking admin status...');
    await checkAdminStatus();
    if (isSteward.value) {
      startPolling();
    }
  }
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
const allMembers = computed(() => {
  const shared = profilesStore.communityProfiles;
  if (shared.length === 0) return [];
  return shared
    .map(p => ({
      profile: (p.data as Record<string, unknown>) || p,
      communityProfile: findCommunityProfile(p),
    }))
    .sort((a, b) => {
      const dateA = (a.communityProfile?.memberSince as string) || (a.profile.createdAt as string) || '';
      const dateB = (b.communityProfile?.memberSince as string) || (b.profile.createdAt as string) || '';
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });
});

const pendingMembers = computed(() =>
  allMembers.value.filter(m => (m.profile.status as string) === 'pending')
);

const liveMembers = computed(() =>
  allMembers.value.filter(m => (m.profile.status as string) !== 'pending')
);

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

// Community stats from activity and chat stores
const totalChannels = computed(() => chatStore.channels.length);
const totalEvents = computed(() => activityStore.notices.filter(n => n.type === 'event').length);
const totalAnnouncements = computed(() => activityStore.notices.filter(n => n.type === 'announcement').length);
const totalUpdates = computed(() => activityStore.notices.filter(n => n.type === 'update').length);

// Time ago helper
function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// Unified activity feed
const noticeIconMap = {
  event: { icon: CalendarDays, iconBg: 'bg-primary-light', iconColor: 'text-primary' },
  announcement: { icon: Megaphone, iconBg: 'bg-accent-light', iconColor: 'text-accent' },
  update: { icon: RefreshCw, iconBg: 'bg-primary-light', iconColor: 'text-primary' },
};

interface FeedItem {
  key: string;
  icon: typeof Users;
  iconBg: string;
  iconColor: string;
  title: string;
  timeAgo: string;
  timestamp: number;
  action: { type: 'member'; member: { profile: Record<string, unknown>; communityProfile?: Record<string, unknown> } }
    | { type: 'channel'; channelId: string }
    | { type: 'notice' };
}

const activityFeed = computed(() => {
  const items: FeedItem[] = [];

  // New members
  for (const m of allMembers.value) {
    const dateStr = (m.communityProfile?.memberSince as string) || (m.profile.createdAt as string);
    if (!dateStr) continue;
    const name = (m.profile.displayName as string) || (m.profile.name as string) || 'Unknown';
    items.push({
      key: `member-${m.profile.aid || name}`,
      icon: UserRoundPlus,
      iconBg: 'bg-accent-light',
      iconColor: 'text-accent',
      title: `${name} joined`,
      timeAgo: timeAgo(dateStr),
      timestamp: new Date(dateStr).getTime(),
      action: { type: 'member', member: m },
    });
  }

  // New channels
  for (const ch of chatStore.channels) {
    items.push({
      key: `channel-${ch.id}`,
      icon: MessageCircle,
      iconBg: 'bg-primary-light',
      iconColor: 'text-primary',
      title: `#${ch.name} channel created`,
      timeAgo: timeAgo(ch.createdAt),
      timestamp: new Date(ch.createdAt).getTime(),
      action: { type: 'channel', channelId: ch.id },
    });
  }

  // Notices (events, announcements, updates)
  for (const n of activityStore.notices.filter(n => n.state === 'published')) {
    const meta = noticeIconMap[n.type];
    const dateStr = n.publishedAt || n.createdAt;
    items.push({
      key: `notice-${n.id}`,
      icon: meta.icon,
      iconBg: meta.iconBg,
      iconColor: meta.iconColor,
      title: n.title,
      timeAgo: timeAgo(dateStr),
      timestamp: new Date(dateStr).getTime(),
      action: { type: 'notice' },
    });
  }

  // Sort by most recent first, limit to 20
  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
});

function handleFeedClick(item: FeedItem) {
  if (item.action.type === 'member') {
    handleMemberClick(item.action.member);
  } else if (item.action.type === 'channel') {
    chatStore.selectChannel(item.action.channelId);
    router.push({ name: 'chat' });
  } else if (item.action.type === 'notice') {
    router.push({ name: 'activity' });
  }
}

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
    selectedMember.value = null;
  }
}

async function handleDecline(registration: PendingRegistration, reason?: string) {
  clearError();
  const success = await declineRegistration(registration, reason);
  if (success) {
    removeRegistration(registration.notificationId);
    selectedMember.value = null;
  }
}

async function handleEndorse(message?: string) {
  clearEndorseError();
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return;
  const registration = selectedMemberRegistration.value;
  const oobi = registration?.applicantOOBI;
  await endorseApplicant(aid, oobi, message);
}

async function handleMarkAttended() {
  clearAttendanceError();
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return;
  const registration = selectedMemberRegistration.value;
  const oobi = registration?.applicantOOBI;
  await markAttended(aid, oobi);
}

function handleCloseModal() {
  clearError();
  clearEndorseError();
  clearAttendanceError();
  selectedMember.value = null;
}

function handleRoleUpdated(newRole: string) {
  if (selectedMember.value?.community) {
    (selectedMember.value.community as Record<string, unknown>).role = newRole;
  }
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

.members-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;

  .card-title {
    margin: 0;
  }
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

.community-stats {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.community-stat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.75rem 0.25rem;
  border-radius: var(--matou-radius);
  background-color: var(--matou-secondary);
}

.community-stat-icon {
  width: 18px;
  height: 18px;
  color: var(--matou-primary);
}

.community-stat-value {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--matou-foreground);
  line-height: 1;
}

.community-stat-label {
  font-size: 0.65rem;
  color: var(--matou-muted-foreground);
  text-align: center;
  line-height: 1.2;
}

.activity-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.activity-empty {
  font-size: 0.825rem;
  color: var(--matou-muted-foreground);
  text-align: center;
  padding: 1rem 0;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;

  &.clickable {
    cursor: pointer;
    border-radius: var(--matou-radius);
    padding: 0.5rem;
    margin: -0.5rem;
    transition: background-color 0.15s ease;

    &:hover {
      background-color: var(--matou-secondary);
    }
  }
}

.community-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;

  .card-title {
    margin: 0;
  }
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border: none;
  background: transparent;
  border-radius: var(--matou-radius);
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
    color: var(--matou-foreground);
  }

  &:disabled {
    cursor: default;
  }
}

.refresh-icon {
  width: 16px;
  height: 16px;

  &.spinning {
    animation: spin 0.8s linear infinite;
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.activity-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--matou-radius);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &.bg-primary-light {
    background-color: rgba(30, 95, 116, 0.1);
  }

  &.bg-accent-light {
    background-color: rgba(74, 157, 156, 0.1);
  }

  .icon {
    width: 20px;
    height: 20px;

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
