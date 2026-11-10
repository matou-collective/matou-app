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
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { BACKEND_KIND_IDSS } from 'src/lib/descriptor';

export type AppConfigState =
  | 'loading'
  | 'configured'
  | 'not_configured'
  // An IDSS backend whose org identity is not yet published: the community is
  // founded by its stewards (ADR 0226 decision 3), so this is a wait state, not
  // the first-admin founding flow.
  | 'backend_provisioning'
  | 'server_unreachable_no_cache'
  | 'server_unreachable_using_cache';

export const useAppStore = defineStore('app', () => {
  // State
  const orgConfig = ref<OrgConfig | null>(null);
  const configState = ref<AppConfigState>('loading');
  const configError = ref<string | null>(null);
  // The community backend kind from the descriptor (ADR 0226); 'idss' for a
  // gateway-served build. Null until the descriptor is read (or if it can't be).
  const backendKind = ref<string | null>(null);

  // Computed
  const hasOrgConfig = computed(() => orgConfig.value !== null);
  const orgAid = computed(() => orgConfig.value?.organization.aid ?? null);
  const orgName = computed(() => orgConfig.value?.organization.name ?? null);
  const orgOobi = computed(() => orgConfig.value?.organization.oobi ?? null);
  const isConfigured = computed(() =>
    configState.value === 'configured' || configState.value === 'server_unreachable_using_cache'
  );
  // An IDSS-backed app never founds — it can only join (ADR 0226 decision 3).
  const isIdssBackend = computed(() => backendKind.value === BACKEND_KIND_IDSS);
  // Only a non-IDSS backend that is genuinely unconfigured routes to /setup.
  const needsSetup = computed(() => configState.value === 'not_configured');
  const isBackendProvisioning = computed(() => configState.value === 'backend_provisioning');
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

    // Resolve the backend kind from the community backend descriptor (ADR 0226,
    // cached from client-config boot). An IDSS backend never founds — it can
    // only join (decision 3) — so a missing org identity must never drop it into
    // the first-admin setup flow. A descriptor fetch failure just leaves the
    // kind unknown and the legacy (non-IDSS) handling applies.
    try {
      const descriptor = await getCommunityDescriptor();
      backendKind.value = descriptor.backend_kind || null;
    } catch {
      // Descriptor unavailable — fall back to legacy handling.
    }

    const result = await fetchOrgConfig();

    switch (result.status) {
      case 'configured':
        orgConfig.value = result.config;
        configState.value = 'configured';
        break;

      case 'not_configured':
        orgConfig.value = null;
        // On an IDSS backend "not configured" never means "found me a new org":
        // the community is founded by its stewards, so a missing org identity
        // means the roster is still being written (or /api/config momentarily
        // 404'd). Surface a wait state, never /setup.
        configState.value = isIdssBackend.value ? 'backend_provisioning' : 'not_configured';
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
    backendKind,

    // Computed
    hasOrgConfig,
    orgAid,
    orgName,
    orgOobi,
    isConfigured,
    isIdssBackend,
    needsSetup,
    isBackendProvisioning,
    hasConfigError,

    // Actions
    setOrgConfig,
    clearConfig,
    loadOrgConfig,
    loadCachedConfig,
  };
});
