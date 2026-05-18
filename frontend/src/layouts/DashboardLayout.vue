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
        <button class="nav-item" :class="{ active: route.name === 'dashboard' }" @click="router.push({ name: 'dashboard' })">
          <Home class="nav-icon" />
          <span>Home</span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'chat' }" @click="router.push({ name: 'chat' })">
          <MessageSquare class="nav-icon" />
          <span>Chat</span>
          <span v-if="chatStore.totalUnreadCount > 0" class="nav-badge">
            {{ chatStore.totalUnreadCount > 99 ? '99+' : chatStore.totalUnreadCount }}
          </span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'wallet' }" @click="router.push({ name: 'wallet' })">
          <Wallet class="nav-icon" />
          <span>Wallet</span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'activity' }" @click="router.push({ name: 'activity' })">
          <Bell class="nav-icon" />
          <span>Notices</span>
          <span v-if="noticesUnreadTotal > 0" class="nav-badge">
            {{ noticesUnreadTotal > 99 ? '99+' : noticesUnreadTotal }}
          </span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'projects' }" @click="router.push({ name: 'projects' })">
          <Target class="nav-icon" />
          <span>Projects</span>
          <span v-if="projectsUnreadTotal > 0" class="nav-badge">
            {{ projectsUnreadTotal > 99 ? '99+' : projectsUnreadTotal }}
          </span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'proposals' }" @click="router.push({ name: 'proposals' })">
          <Vote class="nav-icon" />
          <span>Proposals</span>
        </button>
        <button class="nav-item" :class="{ active: route.name === 'contributions' || route.name === 'contribution-detail' }" @click="router.push({ name: 'contributions' })">
          <Hammer class="nav-icon" />
          <span>Contributions</span>
          <span v-if="contributionsUnreadTotal > 0" class="nav-badge">
            {{ contributionsUnreadTotal > 99 ? '99+' : contributionsUnreadTotal }}
          </span>
        </button>
      </nav>

      <!-- User Profile -->
      <div class="sidebar-footer">
        <div class="user-profile" @click="router.push({ name: 'account-settings' })" style="cursor: pointer;">
          <div class="user-avatar">
            <img v-if="userAvatarUrl" :src="userAvatarUrl" class="w-full h-full rounded-full object-cover" alt="Avatar" />
            <span v-else>{{ userInitials }}</span>
          </div>
          <div class="user-info">
            <span class="user-name">{{ userName }}</span>
            <span class="user-action">View Profile</span>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Content (nested route) -->
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from 'vue';
import {
  Home,
  Wallet,
  Bell,
  Target,
  Vote,
  MessageSquare,
  Hammer,
} from 'lucide-vue-next';
import { useRouter, useRoute } from 'vue-router';
import { useOnboardingStore } from 'stores/onboarding';
import { useProfilesStore } from 'stores/profiles';
import { useTypesStore } from 'stores/types';
import { useChatStore } from 'stores/chat';
import { useCommentCursorsStore } from 'stores/commentCursors';
import { useProjectsStore } from 'stores/projects';
import { useContributionsStore } from 'stores/contributions';
import { useActivityStore } from 'stores/activity';
import { useCommentScope } from 'src/composables/useCommentScope';
import { useBackendEvents } from 'src/composables/useBackendEvents';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { initNotifications, registerNotificationClickHandler } from 'src/lib/notifications';
import { fetchOrgConfig } from 'src/api/config';
import { getFileUrl } from 'src/lib/api/client';

const router = useRouter();
const route = useRoute();
const store = useOnboardingStore();
const profilesStore = useProfilesStore();
const typesStore = useTypesStore();
const chatStore = useChatStore();
const commentCursorsStore = useCommentCursorsStore();
const projectsStore = useProjectsStore();
const contributionsStore = useContributionsStore();
const activityStore = useActivityStore();
const scope = useCommentScope();

const projectsUnreadTotal = computed(() => {
  // Project rollup: own project comments + contribution comments for each
  // project I lead/steward.
  return projectsStore.projects.reduce((sum, p) => {
    const projectContribs = contributionsStore.contributions.filter(
      (c) => c.project_id === p.id,
    );
    return sum + scope.projectRollupUnread(p, projectContribs);
  }, 0);
});

const contributionsUnreadTotal = computed(() => {
  // Only contributions assigned to me — leads/stewards are surfaced via the
  // Projects badge instead.
  return contributionsStore.contributions.reduce(
    (sum, c) => sum + scope.contributionUnreadAsAssignee(c),
    0,
  );
});

const noticesUnreadTotal = computed(() => {
  const list = activityStore.notices ?? [];
  return list.reduce((sum: number, n: { id: string; created_by?: string; createdBy?: string }) => {
    return sum + scope.noticeUnread(n);
  }, 0);
});
const { connect: connectBackendEvents, lastEvent } = useBackendEvents();

// Keep entity comment_count and notice counts in sync with peer comments so
// badges live-update everywhere — not just on the open detail page.
// Only react to p2p-source events: local posts already bump optimistically
// in the store's addComment, so reacting to the local POST handler's SSE
// would double-count.
watch(lastEvent, (event) => {
  if (!event) return;
  const data = event.data as { source?: string; project_id?: string; contribution_id?: string; noticeId?: string } | undefined;
  if (data?.source !== 'p2p') return;
  if (event.type === 'project:comment_added' && data.project_id) {
    projectsStore.bumpCommentCount(data.project_id);
  } else if (event.type === 'contribution:comment_added' && data.contribution_id) {
    contributionsStore.bumpCommentCount(data.contribution_id);
  } else if (event.type === 'notice_comment' && data.noticeId) {
    const current = commentCursorsStore.getNoticeCount(data.noticeId);
    commentCursorsStore.setNoticeCount(data.noticeId, current + 1);
  }
});
const notificationService = useKERINotificationService();

// User info — prefer SharedProfile from community space, fallback to onboarding store
const mySharedProfile = computed(() => {
  const sp = profilesStore.getMyProfile('SharedProfile');
  return sp ? (sp.data as Record<string, unknown>) : null;
});

const userName = computed(() => {
  return (mySharedProfile.value?.displayName as string)
    || store.profile.name
    || 'Member';
});

const userInitials = computed(() => {
  const name = userName.value;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

const userAvatarUrl = computed(() => {
  const avatar = mySharedProfile.value?.avatar as string;
  return avatar ? getFileUrl(avatar) : null;
});

onMounted(() => {
  console.log('[DashboardLayout] mounted, route:', route.name);
  connectBackendEvents();

  // Register click router first, then init so Electron's IPC bridge picks it up.
  registerNotificationClickHandler((data) => {
    if (data.route === 'chat' && data.channelId) {
      router.push({ name: 'chat' }).catch(() => {});
      chatStore.selectChannel(data.channelId);
    }
  });
  initNotifications();

  // Fetch org config once at startup (cached for entire session)
  fetchOrgConfig().catch(err => console.warn('[DashboardLayout] Org config fetch failed:', err));

  // Start the unified KERIA notification service (30s polling)
  notificationService.start();
  typesStore.loadDefinitions();
  profilesStore.loadMyProfiles();
  profilesStore.loadCommunityProfiles();
  profilesStore.loadCommunityReadOnlyProfiles();
  commentCursorsStore.fetch().catch(() => {});

  // Pre-fetch projects, contributions, notices so unread badges render
  // before the user navigates into those sections.
  projectsStore.fetchProjects().catch(() => {});
  contributionsStore.fetchContributions().catch(() => {});
  activityStore.loadNotices().catch(() => {});

  // Load chat data so the unread badge shows on all dashboard pages.
  // Fire-and-forget: don't await, so child routes mount immediately.
  console.log('[DashboardLayout] Starting chat data load...');
  chatStore.loadChannels().then(() => {
    console.log('[DashboardLayout] Channels loaded:', chatStore.channels.length);
    return chatStore.loadReadCursors();
  }).then(() => {
    console.log('[DashboardLayout] Read cursors loaded:', JSON.stringify(chatStore.readCursors));
    return chatStore.loadAllChannelMessages();
  }).then(() => {
    console.log('[DashboardLayout] All messages loaded. Unread counts:', JSON.stringify(chatStore.unreadCounts));
    console.log('[DashboardLayout] Total unread:', chatStore.totalUnreadCount);
  });
});

onBeforeUnmount(() => {
  notificationService.stop();
});
</script>

<style lang="scss" scoped>
.dashboard-layout {
  display: flex;
  min-height: calc(100vh - var(--titlebar-height));
  background-color: var(--matou-background);
}

.main-content {
  flex: 1;
  margin-left: 240px;
  min-height: calc(100vh - var(--titlebar-height));
  width: calc(100% - 240px);
}

// Sidebar
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  // Top padding accounts for the fixed custom titlebar (36px) in Electron.
  // Keeps sidebar content from rendering behind the titlebar.
  padding-top: 40px;
  width: 240px;
  height: 100vh;
  background-color: var(--matou-sidebar);
  border-right: 1px solid var(--matou-sidebar-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow-y: auto;
  z-index: 40;
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
  border-radius: 0 10px 10px 0;
  font-size: 1rem;
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
    border-left: 3px solid var(--matou-sidebar-primary);
    padding-left: calc(0.75rem - 3px);
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

.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 0.375rem;
  background-color: var(--matou-destructive);
  color: white;
  border-radius: 9999px;
  font-size: 0.65rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
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

// Responsive: Hide sidebar on small screens
@media (max-width: 767px) {
  .sidebar {
    display: none;
  }
  
  .main-content {
    margin-left: 0;
  }
}
</style>
