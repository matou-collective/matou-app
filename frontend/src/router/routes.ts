import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('layouts/OnboardingLayout.vue'),
    children: [
      {
        path: '',
        name: 'onboarding',
        component: () => import('pages/OnboardingPage.vue'),
      },
    ],
  },
  {
    path: '/dashboard',
    component: () => import('layouts/DashboardLayout.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('pages/DashboardPage.vue'),
      },
      {
        path: 'settings',
        name: 'account-settings',
        component: () => import('pages/AccountSettingsPage.vue'),
      },
      {
        path: 'chat',
        name: 'chat',
        component: () => import('pages/ChatPage.vue'),
      },
      {
        path: 'wallet',
        name: 'wallet',
        component: () => import('pages/WalletPage.vue'),
      },
      {
        path: 'activity',
        name: 'activity',
        component: () => import('pages/ActivityPage.vue'),
      },
    ],
  },
  {
    path: '/setup',
    component: () => import('layouts/OnboardingLayout.vue'),
    children: [
      {
        path: '',
        name: 'setup',
        component: () => import('pages/SetupPage.vue'),
      },
    ],
  },
  {
    path: '/community-guidelines',
    component: () => import('layouts/OnboardingLayout.vue'),
    children: [
      {
        path: '',
        name: 'community-guidelines',
        component: () => import('pages/CommunityGuidelinesPage.vue'),
      },
    ],
  },
  {
    path: '/privacy-policy',
    component: () => import('layouts/OnboardingLayout.vue'),
    children: [
      {
        path: '',
        name: 'privacy-policy',
        component: () => import('pages/PrivacyPolicyPage.vue'),
      },
    ],
  },
  // Always leave this as last one
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
