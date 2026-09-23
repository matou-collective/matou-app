<template>
  <div
    class="cred-mark"
    :class="{ 'matou-icon': isLegacyMatou, 'has-bg': hasDisplay && !!background }"
    :style="hasDisplay && background ? { background, color: ink } : undefined"
  >
    <!-- Styled credential (a.display present) -->
    <template v-if="hasDisplay">
      <img v-if="showImage && imageUrl" :src="imageUrl" :alt="markAlt" class="mark-image" />
      <component v-else-if="showIcon" :is="iconComponent" :size="iconSize" />
      <!-- Membership: the community logo if the image carried it; else the seal. -->
      <BadgeCheck v-else :size="iconSize" />
    </template>

    <!-- Legacy credential — unchanged from before -->
    <template v-else>
      <img
        v-if="isLegacyMatou"
        src="../../assets/images/matou-bird-logo-blue.svg"
        alt="Mātou"
        class="matou-logo"
      />
      <q-icon v-else :name="legacyMaterialIcon" :size="iconSize + 'px'" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue';
import { BadgeCheck } from 'lucide-vue-next';
import type { WalletCredential } from 'stores/wallet';
import {
  ENDORSEMENT_SCHEMA_SAID,
  EVENT_ATTENDANCE_SCHEMA_SAID,
} from 'src/composables/useAdminActions';
import { useCredentialAppearance } from 'src/composables/useCredentialAppearance';

const props = withDefaults(
  defineProps<{
    credential: WalletCredential;
    iconSize?: number;
  }>(),
  { iconSize: 20 },
);

const credRef = toRef(props, 'credential');
const {
  hasDisplay,
  background,
  ink,
  iconComponent,
  imageUrl,
  showImage,
  showIcon,
} = useCredentialAppearance(credRef);

const markAlt = computed(() => props.credential.display?.name || 'Credential');

// Legacy (non-display) rendering — identical to the previous hardcoded logic.
const isLegacyMatou = computed(
  () =>
    !hasDisplay.value &&
    (props.credential.schemaTitle || '').toLowerCase().includes('matou'),
);

const legacyMaterialIcon = computed(() => {
  if (props.credential.schemaSaid === ENDORSEMENT_SCHEMA_SAID) return 'person_add';
  if (props.credential.schemaSaid === EVENT_ATTENDANCE_SCHEMA_SAID) return 'event_available';
  return 'groups';
});
</script>

<style scoped>
.cred-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
}

/* .has-bg marks a styled mark; the background + contrast-picked ink are applied
   inline (see :style) so Lucide glyphs (currentColor) get the right colour. */

/* A Mātou credential keeps its white chip + border, as before. */
.cred-mark.matou-icon {
  background: white;
  border: 1px solid var(--matou-border, #e5e7eb);
}

.matou-logo {
  width: 60%;
  height: 60%;
}

.mark-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
