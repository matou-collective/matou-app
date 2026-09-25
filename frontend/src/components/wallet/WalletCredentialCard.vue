<!--
  WalletCredentialCard — the wallet's credential card, drawn to the same anatomy
  as the IDSS control panel's credential card so the two read as one design
  (issue #633, follow-up to #622). Element-for-element the panel's card:

    · square bordered mark tile, top-left
    · square uppercase-monospace status chip (white), top-right
    · monospace bold name
    · outlined uppercase-monospace tag box (RECEIVED / ISSUED)
    · muted monospace body lines
    · muted footer line, then a dark square OPEN button

  DESIGN SOURCE — keep in sync with the IDSS panel card. When the panel card
  changes, this file is its named counterpart to update:
    Matou/idss  dashboard/src/components/members/CredentialsSurface.vue (.oc-cred-card)
    Matou/idss  dashboard/src/components/members/credentialCard.scss
    Matou/idss  dashboard/src/components/members/CredentialTile.vue
    Matou/idss  docs/ux/wireframes/p6-members-idip/p6-s7i-credential-detail.html

  A credential's look is fixed at issue (IDSS DDR 0217 ruling 11): a credential
  with an `a.display.background` paints the whole card with contrast ink; one
  without renders the same card shape, unpainted.
-->
<template>
  <article class="wallet-cred-card" :class="{ painted }" :style="cardStyle">
    <header class="cred-head">
      <div class="cred-tile">
        <CredentialMark :credential="credential" :icon-size="24" />
      </div>
      <span class="cred-chip" :class="painted ? 'chip-painted' : statusTone">
        {{ statusLabel }}
      </span>
    </header>

    <div class="cred-body">
      <h4 class="cred-name">{{ name }}</h4>
      <span class="cred-tag">{{ tag }}</span>
      <p v-if="subtitle" class="cred-line cred-subtitle">{{ subtitle }}</p>
      <p v-if="description" class="cred-line">{{ description }}</p>
      <p v-if="recipient" class="cred-line cred-recipient">{{ recipient }}</p>
    </div>

    <footer class="cred-foot">
      <span class="cred-date">{{ footer }}</span>
      <button type="button" class="cred-open" @click="$emit('open')">OPEN</button>
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
// WCAG contrast pick, applied via `color` so the name, tag and body (all
// currentColor-based) follow it. `--cred-paint-bg` carries the background back
// down so the OPEN button and white chip can invert against the painted card.
const background = computed(() => props.credential.display?.background ?? null);
const painted = computed(() => !!background.value);
const ink = computed(() => (background.value ? pickInk(background.value) : null));

const cardStyle = computed(() =>
  painted.value
    ? {
        background: background.value!,
        color: ink.value!,
        '--cred-paint-bg': background.value!,
      }
    : undefined,
);
</script>

<style scoped>
/* Monospace stack — the panel card's display face. The kit ships no mono face,
   so this mirrors the app's `code` stack (src/css/app.scss). */
.wallet-cred-card {
  --cred-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  padding: 1.25rem;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.wallet-cred-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

/* A painted card keeps its own colour; only lift it on hover. */
.wallet-cred-card.painted {
  border-color: transparent;
}

.wallet-cred-card.painted:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
}

.cred-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

/* Mark tile — a small SQUARE tile with a thin border, top-left. */
.cred-tile {
  width: 44px;
  height: 44px;
  border-radius: 0.375rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  overflow: hidden;
  flex-shrink: 0;
}

/* On a painted card the tile border is drawn from the contrast ink so it reads
   against the painted background. */
.painted .cred-tile {
  border-color: color-mix(in srgb, currentColor 24%, transparent);
}

/* Status chip — a SQUARE white chip, top-right, uppercase monospace. */
.cred-chip {
  font-family: var(--cred-mono);
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.2rem 0.5rem;
  border-radius: 0.25rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  background: var(--matou-surface, white);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.cred-chip.healthy {
  color: #059669;
}

.cred-chip.warning {
  color: var(--matou-destructive, #dc2626);
}

/* On a painted card the chip stays white (like the panel's) so it stands off the
   painted background; the tone ink keeps its meaning against white. */
.cred-chip.chip-painted {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  color: #0f172a;
}

.cred-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

/* Name — bold, monospace display face. */
.cred-name {
  margin: 0;
  font-family: var(--cred-mono);
  font-size: 0.9375rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--matou-foreground, #1f2937);
}

.painted .cred-name {
  color: currentColor;
}

/* Tag — a small OUTLINED uppercase monospace box (RECEIVED / ISSUED). */
.cred-tag {
  align-self: flex-start;
  font-family: var(--cred-mono);
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.4375rem;
  border-radius: 0.25rem;
  border: 1px solid var(--matou-border, #cbd5e1);
  background: transparent;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--matou-muted-foreground, #6b7280);
}

.painted .cred-tag {
  border-color: color-mix(in srgb, currentColor 40%, transparent);
  color: currentColor;
}

/* Body — muted monospace lines. */
.cred-line {
  margin: 0;
  font-family: var(--cred-mono);
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--matou-muted-foreground, #6b7280);
}

.cred-subtitle {
  font-weight: 600;
  color: var(--matou-foreground, #374151);
}

.painted .cred-subtitle,
.painted .cred-line {
  color: currentColor;
  opacity: 0.85;
}

.cred-recipient {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Footer — a muted line, then a dark SQUARE OPEN button. */
.cred-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.125rem;
}

.cred-date {
  font-family: var(--cred-mono);
  font-size: 0.6875rem;
  color: var(--matou-muted-foreground, #9ca3af);
}

.painted .cred-date {
  color: currentColor;
  opacity: 0.75;
}

.cred-open {
  font-family: var(--cred-mono);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0.375rem 0.875rem;
  border: none;
  border-radius: 0.25rem;
  background: var(--matou-foreground, #1f2937);
  color: var(--matou-background, #ffffff);
  cursor: pointer;
  text-transform: uppercase;
  transition: opacity 0.15s ease;
}

.cred-open:hover {
  opacity: 0.85;
}

/* On a painted card the OPEN button uses the contrast ink as its fill and the
   card's own background colour as its text — a dark square that stays readable. */
.painted .cred-open {
  background: currentColor;
  color: var(--cred-paint-bg, #ffffff);
}
</style>
