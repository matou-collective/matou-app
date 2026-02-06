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
        <button class="nav-item" :class="{ active: route.name === 'wallet' }" @click="router.push({ name: 'wallet' })">
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
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import {
  Home,
  Wallet,
  Target,
  Vote,
  MessageSquare,
} from 'lucide-vue-next';
import { useRouter, useRoute } from 'vue-router';
import { useOnboardingStore } from 'stores/onboarding';
import { useProfilesStore } from 'stores/profiles';
import { useTypesStore } from 'stores/types';
import { getFileUrl } from 'src/lib/api/client';

const router = useRouter();
const route = useRoute();
const store = useOnboardingStore();
const profilesStore = useProfilesStore();
const typesStore = useTypesStore();

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
  typesStore.loadDefinitions();
  profilesStore.loadMyProfiles();
  profilesStore.loadCommunityProfiles();
  profilesStore.loadCommunityReadOnlyProfiles();
});
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

// Responsive: Hide sidebar on small screens
@media (max-width: 767px) {
  .sidebar {
    display: none;
  }
}
</style>
