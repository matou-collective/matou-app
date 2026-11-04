/**
 * i18n boot (#783).
 *
 * Installs vue-i18n and resolves the first-run locale: an explicit prior
 * choice wins, else the community's primary language (when known), else the
 * device/browser language, else `en`. The community primary usually isn't
 * known at boot (the org config is fetched later), so a watcher re-applies it
 * once the config loads — unless the member has since picked a language.
 */
import { boot } from 'quasar/wrappers';
import { watch } from 'vue';
import type { WritableComputedRef } from 'vue';
import { createI18nInstance } from 'src/i18n';
import {
  resolveInitialLocale,
  loadStoredLocale,
  deviceLanguages,
  matchLocale,
} from 'src/i18n/resolve';
import { useAppStore } from 'stores/app';

/** The org config may carry a community primary language; today it's optional. */
function communityPrimaryFrom(config: unknown): string | null {
  const c = config as { primaryLanguage?: string } | null;
  return c?.primaryLanguage ?? null;
}

export default boot(({ app }) => {
  let communityPrimary: string | null = null;
  let appStore: ReturnType<typeof useAppStore> | null = null;
  try {
    appStore = useAppStore();
    communityPrimary = communityPrimaryFrom(appStore.orgConfig);
  } catch {
    // Pinia not ready / store unavailable — fall through to device language.
  }

  const i18n = createI18nInstance(
    resolveInitialLocale({
      stored: loadStoredLocale(),
      communityPrimary,
      deviceLanguages: deviceLanguages(),
    }),
  );
  app.use(i18n);

  // The org config lands after boot. When it does, adopt the community's
  // primary language as the default — but never override an explicit choice.
  if (appStore) {
    const locale = i18n.global.locale as WritableComputedRef<string>;
    watch(
      () => communityPrimaryFrom(appStore!.orgConfig),
      (primary) => {
        if (loadStoredLocale()) return;
        const matched = matchLocale(primary);
        if (matched) locale.value = matched;
      },
    );
  }
});
