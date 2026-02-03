/**
 * App Store
 * Stores app-level state including organization configuration
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  fetchOrgConfig,
  getCachedConfig,
  type OrgConfig,
  type ConfigResult,
} from 'src/api/config';

export type AppConfigState =
  | 'loading'
  | 'configured'
  | 'not_configured'
  | 'server_unreachable_no_cache'
  | 'server_unreachable_using_cache';

export const useAppStore = defineStore('app', () => {
  // State
  const orgConfig = ref<OrgConfig | null>(null);
  const configState = ref<AppConfigState>('loading');
  const configError = ref<string | null>(null);

  // Computed
  const hasOrgConfig = computed(() => orgConfig.value !== null);
  const orgAid = computed(() => orgConfig.value?.organization.aid ?? null);
  const orgName = computed(() => orgConfig.value?.organization.name ?? null);
  const orgOobi = computed(() => orgConfig.value?.organization.oobi ?? null);
  const isConfigured = computed(() =>
    configState.value === 'configured' || configState.value === 'server_unreachable_using_cache'
  );
  const needsSetup = computed(() => configState.value === 'not_configured');
  const hasConfigError = computed(() => configState.value === 'server_unreachable_no_cache');

  // Actions
  function setOrgConfig(config: OrgConfig) {
    orgConfig.value = config;
    configState.value = 'configured';
    configError.value = null;
  }

  function clearConfig() {
    orgConfig.value = null;
    configState.value = 'loading';
    configError.value = null;
  }

  /**
   * Load org config from server (with localStorage fallback)
   * This is the main entry point called during app boot
   */
  async function loadOrgConfig(): Promise<ConfigResult> {
    configState.value = 'loading';
    configError.value = null;

    const result = await fetchOrgConfig();

    switch (result.status) {
      case 'configured':
        orgConfig.value = result.config;
        configState.value = 'configured';
        break;

      case 'not_configured':
        orgConfig.value = null;
        configState.value = 'not_configured';
        break;

      case 'server_unreachable':
        if (result.cached) {
          orgConfig.value = result.cached;
          configState.value = 'server_unreachable_using_cache';
          console.log('[AppStore] Using cached config (server unreachable)');
        } else {
          orgConfig.value = null;
          configState.value = 'server_unreachable_no_cache';
          configError.value = 'Cannot connect to config server. Please ensure the server is running.';
        }
        break;
    }

    return result;
  }

  /**
   * Get cached config (for immediate checks)
   */
  async function loadCachedConfig(): Promise<boolean> {
    const cached = await getCachedConfig();
    if (cached) {
      orgConfig.value = cached;
      return true;
    }
    return false;
  }

  return {
    // State
    orgConfig,
    configState,
    configError,

    // Computed
    hasOrgConfig,
    orgAid,
    orgName,
    orgOobi,
    isConfigured,
    needsSetup,
    hasConfigError,

    // Actions
    setOrgConfig,
    clearConfig,
    loadOrgConfig,
    loadCachedConfig,
  };
});
