<template>
  <div class="dashboard-layout" :class="{ 'keyboard-open': keyboardOpen }">
    <!-- Sidebar -->
    <aside class="sidebar">
      <!-- Logo Header -->
      <div class="sidebar-header">
        <div class="logo-container">
          <img :src="kitLogo" :alt="KIT.brand.name" class="logo-icon" />
          <div class="logo-text">
            <span class="logo-title">{{ KIT.brand.name }}</span>
            <span class="logo-subtitle">Community</span>
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <nav class="sidebar-nav">
        <button
          v-for="item in navItems"
          :key="item.name"
          class="nav-item"
          :class="{ active: isNavActive(item) }"
          @click="router.push({ name: item.name })"
        >
          <component :is="item.icon" class="nav-icon" />
          <span>{{ item.label }}</span>
          <span v-if="item.badge > 0" class="nav-badge">{{ badgeLabel(item.badge) }}</span>
        </button>
        <div class="sidebar-nav-bottom">
          <!-- Community Settings gear — shown only for holders of
               open_community_settings (founder by default); sits directly above
               "Report an issue" (#318). -->
          <button
            v-if="rolePolicyStore.can('open_community_settings')"
            class="nav-item community-settings-btn"
            @click="router.push({ name: 'community-settings' })"
          >
            <Settings class="nav-icon" />
            <span>Community Settings</span>
          </button>
          <button class="nav-item report-issue-btn" @click="showReportDialog = true">
            <Bug class="nav-icon" />
            <span>Report an issue</span>
          </button>
        </div>
      </nav>

      <!-- Footer: user profile -->
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
    <main class="main-content" :class="{ 'is-chat-route': route.name === 'chat' }">
      <router-view />
    </main>

    <!-- Mobile bottom tab bar (≤767px) — sidebar is hidden there, so this is
         the only navigation. Shows the primary navItems plus a "More" tab; the
         overflow navItems and the profile link live behind the More sheet.
         "Report an issue" lives on Account settings on mobile. -->
    <nav class="bottom-nav">
      <button
        v-for="item in primaryNavItems"
        :key="item.name"
        class="bottom-nav-item"
        :class="{ active: isNavActive(item) }"
        @click="navigateTo(item.name)"
      >
        <span class="bottom-nav-icon-wrap">
          <component :is="item.icon" class="bottom-nav-icon" />
          <span v-if="item.badge > 0" class="bottom-nav-badge">{{ badgeLabel(item.badge) }}</span>
        </span>
        <span class="bottom-nav-label">{{ item.label }}</span>
      </button>
      <button
        class="bottom-nav-item more-tab"
        :class="{ active: showMoreSheet || isOverflowActive }"
        aria-label="More"
        @click="showMoreSheet = true"
      >
        <span class="bottom-nav-icon-wrap">
          <Menu class="bottom-nav-icon" />
          <span v-if="overflowBadgeTotal > 0" class="bottom-nav-badge">{{ badgeLabel(overflowBadgeTotal) }}</span>
        </span>
        <span class="bottom-nav-label">More</span>
      </button>
    </nav>

    <!-- "More" overflow sheet (≤767px): scrim + a bottom sheet above the tab
         bar listing the overflow navItems and the profile link. Tapping an
         entry navigates and closes the sheet. -->
    <Transition name="more-sheet">
      <div v-if="showMoreSheet" class="more-sheet-overlay" @click="showMoreSheet = false">
        <div class="more-sheet" role="dialog" aria-label="More navigation" @click.stop>
          <div class="more-sheet-handle" />
          <button
            v-for="item in overflowNavItems"
            :key="item.name"
            class="more-sheet-item"
            :class="{ active: isNavActive(item) }"
            @click="navigateTo(item.name)"
          >
            <span class="more-sheet-icon-wrap">
              <component :is="item.icon" class="more-sheet-icon" />
            </span>
            <span class="more-sheet-label">{{ item.label }}</span>
            <span v-if="item.badge > 0" class="more-sheet-badge">{{ badgeLabel(item.badge) }}</span>
          </button>
          <button
            class="more-sheet-item"
            :class="{ active: route.name === 'account-settings' }"
            @click="navigateTo('account-settings')"
          >
            <span class="more-sheet-icon-wrap">
              <span class="more-sheet-avatar">
                <img v-if="userAvatarUrl" :src="userAvatarUrl" class="w-full h-full rounded-full object-cover" alt="Avatar" />
                <span v-else>{{ userInitials }}</span>
              </span>
            </span>
            <span class="more-sheet-label">{{ userName }}</span>
          </button>
          <button
            class="more-sheet-item more-sheet-item-separated"
            @click="showMoreSheet = false; showReportDialog = true"
          >
            <span class="more-sheet-icon-wrap">
              <Bug class="more-sheet-icon" />
            </span>
            <span class="more-sheet-label">Report an issue</span>
          </button>
        </div>
      </div>
    </Transition>

    <!-- App-wide read-only profile viewer, driven by clicks on any UserAvatar -->
    <ProfileModal
      :show="profileViewer.isOpen"
      :shared-profile="profileViewer.sharedProfile"
      :community-profile="profileViewer.communityProfile"
      @close="profileViewer.close()"
    />
    <ReportIssueDialog v-model="showReportDialog" :reporter-name="userName" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, type Component } from 'vue';
import {
  Home,
  Wallet,
  Bell,
  Target,
  Vote,
  MessageSquare,
  Hammer,
  Bug,
  Menu,
  Settings,
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
import { useRolePolicyStore } from 'src/stores/rolePolicy';
import { useIdentityStore } from 'stores/identity';
import { useCommentScope } from 'src/composables/useCommentScope';
import { useKeyboardOpen } from 'src/composables/useKeyboardOpen';
import { useBackendEvents } from 'src/composables/useBackendEvents';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { initNotifications, registerNotificationClickHandler } from 'src/lib/notifications';
import { fetchOrgConfig } from 'src/api/config';
import { getFileUrl } from 'src/lib/api/client';
import ProfileModal from 'src/components/profiles/ProfileModal.vue';
import ReportIssueDialog from 'src/components/common/ReportIssueDialog.vue';
import { useProfileViewer } from 'stores/profileViewer';
import { KIT } from 'src/generated/kit';
import kitLogo from 'src/assets/kit/logo.png';
import {
  NAV_ITEM_META,
  isNavActive as isNavActiveFor,
  badgeLabel,
  type NavItemMeta,
} from 'src/composables/navItems';

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
const rolePolicyStore = useRolePolicyStore();
const identityStore = useIdentityStore();
const scope = useCommentScope();
const profileViewer = useProfileViewer();
const showReportDialog = ref(false);

// Hide the mobile bottom tab bar while the soft keyboard is open so it doesn't
// float above the keyboard and eat vertical space (#126). Web/Electron never
// see a keyboard, so the flag stays false there.
const keyboardOpen = useKeyboardOpen();

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
  // Comment unread on contributions assigned to me + any pending offers
  // extended to me (drops back as soon as I accept the offer).
  // Leads/stewards' comment unread is surfaced via the Projects badge instead.
  return contributionsStore.contributions.reduce(
    (sum, c) => sum + scope.contributionUnreadAsAssignee(c) + scope.contributionOfferedCount(c),
    0,
  );
});

const noticesUnreadTotal = computed(() => {
  const list = activityStore.notices ?? [];
  return list.reduce((sum: number, n: { id: string; created_by?: string; createdBy?: string }) => {
    return sum + scope.noticeUnread(n);
  }, 0);
});
// Primary navigation: the sidebar (desktop) and the bottom tab bar (mobile,
// ≤767px) both render from one array so they never drift out of sync. Static
// metadata (name/label/aliases) lives in navItems.ts; here we map an icon and
// the live unread badge onto each entry.
const NAV_ICONS: Record<string, Component> = {
  dashboard: Home,
  chat: MessageSquare,
  wallet: Wallet,
  activity: Bell,
  proposals: Vote,
  projects: Target,
  contributions: Hammer,
};

const navBadges = computed<Record<string, number>>(() => ({
  chat: chatStore.totalUnreadCount,
  activity: noticesUnreadTotal.value,
  projects: projectsUnreadTotal.value,
  contributions: contributionsUnreadTotal.value,
}));

const navItems = computed(() =>
  NAV_ITEM_META.map((meta) => ({
    ...meta,
    icon: NAV_ICONS[meta.name] as Component,
    badge: navBadges.value[meta.name] ?? 0,
  })),
);

// Mobile bottom bar splits navItems into the primary tabs (own tab) and the
// overflow entries shown behind the "More" tab's sheet. The desktop sidebar
// keeps rendering the full `navItems` list.
const primaryNavItems = computed(() => navItems.value.filter((i) => i.primary));
const overflowNavItems = computed(() => navItems.value.filter((i) => !i.primary));

// The More tab rolls the overflow entries' unread counts into one badge and
// lights up whenever the current route is any overflow destination (an overflow
// navItem or the profile → account-settings link).
const overflowBadgeTotal = computed(() =>
  overflowNavItems.value.reduce((sum, i) => sum + i.badge, 0),
);
const isOverflowActive = computed(() => {
  if (route.name === 'account-settings') return true;
  return overflowNavItems.value.some((i) => isNavActive(i));
});

const showMoreSheet = ref(false);

function isNavActive(item: NavItemMeta): boolean {
  return isNavActiveFor(item, route.name as string | null | undefined);
}

// Navigate from the mobile bottom bar / More sheet, closing the sheet after.
function navigateTo(name: string): void {
  showMoreSheet.value = false;
  void router.push({ name });
}

const { connect: connectBackendEvents, lastEvent } = useBackendEvents();

// Keep entity comment_count and notice counts in sync with peer comments so
// badges live-update everywhere — not just on the open detail page.
// Only react to p2p-source events for the *_comment_added events: local
// posts already bump optimistically in the store's addComment, so reacting
// to the local POST handler's SSE would double-count.
watch(lastEvent, (event) => {
  if (!event) return;
  const data = event.data as {
    source?: string;
    project_id?: string;
    contribution_id?: string;
    noticeId?: string;
  } | undefined;

  // Lifecycle changes that may flip a contribution's status or offered_to —
  // refresh the single contribution so the offered badge + side-menu rollup
  // update in real time. Handles both local broadcasts (status:assigned,
  // accepted) and p2p-synced contribution_updated.
  if (
    (event.type === 'contribution:assigned'
      || event.type === 'contribution:accepted'
      || event.type === 'contribution:declined'
      || event.type === 'contribution_updated')
    && data?.contribution_id
  ) {
    void contributionsStore.refreshContribution(data.contribution_id);
    return;
  }

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
  // Role policy drives the admin-only Roles nav entry. callerCapabilities
  // depend on X-User-AID, which is only sent once the identity store has an
  // AID — after a recovery login that lands later than mount — so (re)load
  // whenever the AID changes rather than once.
  watch(
    () => identityStore.aidPrefix,
    () => {
      void rolePolicyStore.load();
    },
    { immediate: true },
  );

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

// The bottom cluster (Community Settings + Report an issue) is pushed to the
// foot of the nav column so it keeps its place whether or not the gear shows.
.sidebar-nav-bottom {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.community-settings-btn,
.report-issue-btn {
  font-size: 0.85rem;
  color: var(--matou-sidebar-foreground);
  opacity: 0.75;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;

  &:hover {
    opacity: 1;
  }

  .nav-icon {
    width: 16px;
    height: 16px;
  }
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

// Mobile bottom tab bar — hidden on desktop, shown only at ≤767px.
// Height comes from the shared `--bottom-nav-height` token (see App.vue) so the
// chat view reserves matching space for the composer (#168).
.bottom-nav {
  display: none;
}

.bottom-nav-item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 2px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-sidebar-foreground);
  border-radius: 10px;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;

  // Selected tab gets the kit secondary wash behind it (matches the sidebar's
  // .active treatment). Kit-driven via --matou-sidebar-accent. See #337.
  &.active {
    color: var(--matou-sidebar-primary);
    background-color: var(--matou-sidebar-accent);
  }
}

.bottom-nav-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bottom-nav-icon {
  width: 22px;
  height: 22px;
}

.bottom-nav-label {
  font-size: 0.625rem;
  line-height: 1;
  font-weight: 500;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bottom-nav-badge {
  position: absolute;
  top: -6px;
  left: 12px;
  min-width: 16px;
  height: 16px;
  padding: 0 0.25rem;
  background-color: var(--matou-destructive);
  color: white;
  border-radius: 9999px;
  font-size: 0.6rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

// "More" overflow sheet — hidden by default, shown only at ≤767px.
.more-sheet-overlay {
  display: none;
}

.more-sheet {
  background-color: var(--matou-sidebar);
  border-top: 1px solid var(--matou-sidebar-border);
  border-radius: 16px 16px 0 0;
  padding: 8px 0 12px;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18);
}

.more-sheet-handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background-color: var(--matou-sidebar-border);
  margin: 4px auto 8px;
}

.more-sheet-item {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  width: 100%;
  padding: 0.75rem 1.25rem;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 1rem;
  font-weight: 500;
  color: var(--matou-sidebar-foreground);

  &.active {
    color: var(--matou-sidebar-primary);
  }
}

.more-sheet-item-separated {
  margin-top: 4px;
  border-top: 1px solid var(--matou-sidebar-border);
  padding-top: calc(0.75rem + 4px);
}

.more-sheet-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}

.more-sheet-icon {
  width: 22px;
  height: 22px;
}

.more-sheet-label {
  flex: 1 1 auto;
}

.more-sheet-badge {
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

.more-sheet-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 0.6rem;
  font-weight: 600;
}

// Sheet slide-up / scrim fade.
.more-sheet-enter-active,
.more-sheet-leave-active {
  transition: opacity 0.2s ease;

  .more-sheet {
    transition: transform 0.2s ease;
  }
}

.more-sheet-enter-from,
.more-sheet-leave-to {
  opacity: 0;

  .more-sheet {
    transform: translateY(100%);
  }
}

// Responsive: Hide sidebar on small screens, show the bottom tab bar instead.
@media (max-width: 767px) {
  .sidebar {
    display: none;
  }

  .main-content {
    margin-left: 0;
    width: 100%;
    // On mobile there is no top sidebar/header, so page content starts at the
    // very top of an edge-to-edge WebView — clear the status bar with the top
    // safe-area inset (0 on web/Electron).
    padding-top: env(safe-area-inset-top);
    // Keep content clear of the fixed bottom bar (bar height + safe area).
    padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
  }

  // Chat manages its own bottom-nav inset (ChatPage.vue's reserve-tab-bar),
  // so this layout must not double up or the page ends up taller than the
  // viewport and over-scrolling reveals empty space below the composer.
  .main-content.is-chat-route {
    padding-bottom: 0;
  }

  .bottom-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background-color: var(--matou-sidebar);
    border-top: 1px solid var(--matou-sidebar-border);
    z-index: 50;
  }

  .more-sheet-overlay {
    // Flex column anchored to the bottom so the sheet sits just above the tab
    // bar with the scrim filling the rest of the screen behind it.
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    position: fixed;
    inset: 0;
    z-index: 60;
    background-color: rgba(0, 0, 0, 0.4);
    padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
  }

  // Soft keyboard open (#126): hide the bottom tab bar so it doesn't float
  // above the keyboard, and reclaim its reserved content padding.
  .dashboard-layout.keyboard-open .bottom-nav {
    display: none;
  }

  .dashboard-layout.keyboard-open .main-content {
    padding-bottom: 0;
  }
}
</style>
