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
      <p v-if="serviceName" class="cred-line cred-prod">
        services know it as <code>{{ serviceName }}</code>
      </p>
      <p v-else-if="subtitle" class="cred-line cred-subtitle">{{ subtitle }}</p>
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
  /** The slug services gate on (a.committee / role) — the panel's "services know it as" line. */
  serviceName?: string;
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
/* Metrics are the panel card's (credentialCard.scss .oc-cred-card): 12/14px
   padding, 10px radius, 1.5px border, 32px tile, chip pinned top-right, the foot
   line pushed to the bottom with OPEN under it. The grid that holds these cards
   (CredentialsTab .cards-grid) lays them out in a row at the panel's width. */
.wallet-cred-card {
  --cred-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  position: relative;
  min-width: 0;
  box-sizing: border-box;
  height: 100%;
  font-family: var(--cred-mono);
  background: var(--matou-card, white);
  border: 1.5px solid var(--matou-border, #e5e7eb);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.15s ease;
}

.wallet-cred-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.wallet-cred-card.painted {
  border-color: color-mix(in srgb, currentColor 18%, transparent);
}

.cred-head {
  margin-bottom: 8px;
}

/* Mark tile — 32px square, top-left. */
.cred-tile {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--matou-border, #e5e7eb);
  overflow: hidden;
  flex-shrink: 0;
}

.painted .cred-tile {
  border-color: color-mix(in srgb, currentColor 24%, transparent);
}

/* Status chip — pinned top-right, white, uppercase monospace. */
.cred-chip {
  position: absolute;
  top: 10px;
  right: 10px;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--matou-border, #e5e7eb);
  background: #ffffff;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.cred-chip.healthy {
  color: #3f6b3a;
}

.cred-chip.warning {
  color: var(--matou-destructive, #dc2626);
}

.cred-chip.chip-painted {
  border-color: rgba(0, 0, 0, 0.08);
  color: #3f6b3a;
}

.cred-body {
  display: flex;
  flex-direction: column;
}

.cred-name {
  margin: 0 0 2px;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.35;
  color: var(--matou-foreground, #1f2937);
}

.painted .cred-name {
  color: currentColor;
}

/* Tag — outlined uppercase box (RECEIVED / ISSUED). */
.cred-tag {
  align-self: flex-start;
  margin: 2px 0 6px;
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.5;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid currentColor;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--matou-foreground, #1f2937);
}

.painted .cred-tag {
  color: currentColor;
}

.cred-line {
  margin: 0 0 6px;
  font-size: 0.875rem;
  line-height: 1.35;
  color: var(--matou-foreground, #1f2937);
  overflow-wrap: anywhere;
}

.painted .cred-line {
  color: currentColor;
}

/* "services know it as <slug>" — the panel's muted production-name line. */
.cred-prod {
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.cred-prod code {
  font: inherit;
  font-weight: 700;
  background: none;
  padding: 0;
  color: inherit;
}

.painted .cred-prod {
  color: currentColor;
  opacity: 0.75;
}

.cred-subtitle {
  font-weight: 600;
}

.cred-recipient {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Foot — the muted line sits at the bottom, OPEN under it, left-aligned. */
.cred-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.cred-date {
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.painted .cred-date {
  color: currentColor;
  opacity: 0.75;
}

.cred-open {
  margin-top: 8px;
  font-family: var(--cred-mono);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 6px 13px;
  border: 1px solid var(--matou-foreground, #1f2937);
  border-radius: 6px;
  background: var(--matou-foreground, #1f2937);
  color: var(--matou-background, #ffffff);
  cursor: pointer;
  text-transform: uppercase;
}

.cred-open:hover,
.cred-open:focus-visible {
  filter: brightness(1.2);
  outline: none;
}

.painted .cred-open {
  background: #3f3f3f;
  border-color: #3f3f3f;
  color: #ffffff;
}
</style>
