<template>
  <article
    class="wallet-cred-card"
    :class="{ painted }"
    :style="cardStyle"
    @click="$emit('open')"
  >
    <header class="cred-head">
      <div class="cred-tile">
        <CredentialMark :credential="credential" :icon-size="24" />
      </div>
      <span class="cred-pill" :class="painted ? 'pill-painted' : statusTone">
        {{ statusLabel }}
      </span>
    </header>

    <div class="cred-body">
      <h4 class="cred-name">{{ name }}</h4>
      <span class="cred-tag" :class="{ 'tag-painted': painted }">{{ tag }}</span>
      <p v-if="subtitle" class="cred-subtitle">{{ subtitle }}</p>
      <p v-if="description" class="cred-desc">{{ description }}</p>
    </div>

    <footer class="cred-foot">
      <span class="cred-date">{{ footer }}</span>
      <span v-if="recipient" class="cred-recipient">{{ recipient }}</span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WalletCredential } from 'stores/wallet';
import { pickInk } from 'src/lib/credentialAppearance';
import CredentialMark from './CredentialMark.vue';

const props = defineProps<{
  credential: WalletCredential;
  name: string;
  tag: string;
  statusLabel: string;
  statusTone: 'healthy' | 'warning';
  subtitle?: string;
  description?: string;
  footer: string;
  recipient?: string;
}>();

defineEmits<{ (e: 'open'): void }>();

// A credential with a `display.background` paints the whole card; the ink is the
// WCAG contrast pick, applied via `color` so text, tag and tile surround (all
// currentColor-based) follow it.
const background = computed(() => props.credential.display?.background ?? null);
const painted = computed(() => !!background.value);
const ink = computed(() => (background.value ? pickInk(background.value) : null));

const cardStyle = computed(() =>
  painted.value ? { background: background.value!, color: ink.value! } : undefined,
);
</script>

<style scoped>
.wallet-cred-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  padding: 1.25rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.wallet-cred-card:hover {
  border-color: var(--matou-primary, #1e5f74);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

/* A painted card keeps its own colour on hover; only lift it. */
.wallet-cred-card.painted {
  border-color: transparent;
}

.wallet-cred-card.painted:hover {
  border-color: transparent;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
}

.cred-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

/* Mark tile — the panel's rounded-square, sized to match CredentialTile. */
.cred-tile {
  width: 44px;
  height: 44px;
  border-radius: 0.625rem;
  overflow: hidden;
  flex-shrink: 0;
}

/* On a painted card the tile sits in a translucent surround drawn from the
   contrast ink, so the mark reads against the same background. */
.painted .cred-tile {
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent);
}

/* Status pill — top right, toned like the panel's OcPill. */
.cred-pill {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.2rem 0.625rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.cred-pill.healthy {
  background: #ecfdf5;
  color: #059669;
}

.cred-pill.warning {
  background: #fef2f2;
  color: #dc2626;
}

/* On a painted card the pill echoes the contrast ink instead of a fixed tone. */
.cred-pill.pill-painted {
  background: color-mix(in srgb, currentColor 16%, transparent);
  color: currentColor;
}

.cred-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.cred-name {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
}

.painted .cred-name {
  color: currentColor;
}

/* Small tag under the name — Received / Issued. */
.cred-tag {
  align-self: flex-start;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: var(--matou-secondary, #e8f4f8);
  color: var(--matou-primary, #1e5f74);
}

.cred-tag.tag-painted {
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: currentColor;
}

.cred-subtitle {
  margin: 0.125rem 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--matou-foreground, #374151);
}

.painted .cred-subtitle {
  color: currentColor;
}

.cred-desc {
  margin: 0.125rem 0 0;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.painted .cred-desc {
  color: currentColor;
  opacity: 0.85;
}

.cred-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #9ca3af);
}

.painted .cred-foot {
  color: currentColor;
  opacity: 0.75;
}

.cred-recipient {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
