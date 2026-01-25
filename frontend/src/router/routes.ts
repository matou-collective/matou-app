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
    component: () => import('layouts/OnboardingLayout.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('pages/DashboardPage.vue'),
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
  // Always leave this as last one
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
