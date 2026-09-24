import { ref, computed, watch, type Ref } from 'vue';
import type { WalletCredential } from 'stores/wallet';
import {
  resolveLucideIcon,
  pickInk,
  loadVerifiedImage,
} from 'src/lib/credentialAppearance';

/**
 * Reactive "look" for a credential's mark, shared by the wallet card and the
 * detail dialog. When the credential carries an `a.display` block it yields the
 * community's styling (icon / verified image / colour); otherwise everything is
 * null/false and the caller renders the legacy mark unchanged.
 *
 * Mark priority when `display` is present: verified image → Lucide icon → seal.
 */
export function useCredentialAppearance(cred: Ref<WalletCredential>) {
  const display = computed(() => cred.value.display);
  const hasDisplay = computed(() => !!display.value);
  const background = computed(() => display.value?.background ?? null);
  const ink = computed(() => (background.value ? pickInk(background.value) : null));

  const iconComponent = ref<unknown | null>(null);
  const imageUrl = ref<string | null>(null);

  const showImage = computed(() => hasDisplay.value && !!imageUrl.value);
  const showIcon = computed(
    () => hasDisplay.value && !showImage.value && !!iconComponent.value,
  );
  // Anything styled that resolves to neither a verified image nor a known icon
  // falls back to the IDSS seal.
  const showSeal = computed(
    () => hasDisplay.value && !showImage.value && !showIcon.value,
  );

  watch(
    display,
    (d) => {
      iconComponent.value = null;
      imageUrl.value = null;
      if (!d) return;

      if (d.icon) {
        void resolveLucideIcon(d.icon).then((comp) => {
          // Ignore a stale resolve if the credential changed underneath us.
          if (display.value === d) iconComponent.value = comp;
        });
      }
      if (d.image) {
        const img = d.image;
        void loadVerifiedImage(img).then((url) => {
          if (display.value === d) imageUrl.value = url;
        });
      }
    },
    { immediate: true },
  );

  return {
    hasDisplay,
    display,
    background,
    ink,
    iconComponent,
    imageUrl,
    showImage,
    showIcon,
    showSeal,
  };
}
