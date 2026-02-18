<template>
  <div class="credentials-tab">
    <!-- View toggle -->
    <div class="view-toggle">
      <button
        class="toggle-btn"
        :class="{ active: viewMode === 'cards' }"
        @click="viewMode = 'cards'"
      >
        <LayoutGrid :size="16" />
        Cards
      </button>
      <button
        class="toggle-btn"
        :class="{ active: viewMode === 'graph' }"
        @click="viewMode = 'graph'"
      >
        <Network :size="16" />
        Graph
      </button>
    </div>

    <!-- Loading -->
    <div v-if="walletStore.credentialsLoading" class="loading-state">
      <Loader2 :size="24" class="spinner" />
      <span>Loading credentials...</span>
    </div>

    <!-- Error -->
    <div v-else-if="walletStore.credentialsError" class="error-state">
      <AlertCircle :size="20" />
      <span>{{ walletStore.credentialsError }}</span>
    </div>

    <!-- Empty state -->
    <div v-else-if="walletStore.credentials.length === 0" class="empty-state">
      <ShieldOff :size="40" />
      <h3>No credentials yet</h3>
      <p>Credentials issued to your wallet will appear here.</p>
    </div>

    <!-- Card list view -->
    <div v-else-if="viewMode === 'cards'" class="cards-grid">
      <div
        v-for="cred in walletStore.credentials"
        :key="cred.said"
        class="credential-card"
        :class="{ 'card-issued': isIssuedByMe(cred) }"
        @click="selectedCredential = cred"
      >
        <div class="card-top">
          <div class="card-icon" :class="{ 'matou-icon': isMatouCredential(cred) }">
            <img v-if="isMatouCredential(cred)" src="../../assets/images/matou-bird-logo-blue.svg" alt="Matou" class="matou-logo" />
            <ShieldCheck v-else :size="20" />
          </div>
          <div class="card-top-right">
            <span v-if="isIssuedByMe(cred)" class="direction-badge direction-issued">Issued</span>
            <span v-else class="direction-badge direction-received">Received</span>
            <span class="status-badge" :class="statusClass(cred.status)">
              {{ statusLabel(cred.status) }}
            </span>
          </div>
        </div>
        <div class="card-body">
          <h4 class="card-title">{{ cred.schemaTitle || cred.role || 'Credential' }}</h4>
          <p class="card-role" v-if="cred.schemaTitle && cred.role">{{ cred.role }}</p>
          <p class="card-community">{{ cred.communityName || 'Unknown community' }}</p>
          <p v-if="isIssuedByMe(cred)" class="card-recipient">To: {{ issuerDisplayName(cred.issueeAid) }}</p>
        </div>
        <div class="card-footer">
          <span class="card-date">{{ formatDate(cred.issuedAt) }}</span>
        </div>
      </div>
    </div>

    <!-- Relationship graph view -->
    <div v-else class="graph-view" ref="graphContainer">
      <svg :width="graphWidth" :height="graphHeight" class="graph-svg">
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
            <polygon points="0 0, 10 4, 0 8" fill="var(--matou-muted-foreground, #9ca3af)" />
          </marker>
          <marker id="arrowhead-issued" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
            <polygon points="0 0, 10 4, 0 8" fill="#e57e24" />
          </marker>
        </defs>
        <!-- Connection lines — received: outer→center, issued: center→outer -->
        <line
          v-for="(cred, idx) in walletStore.credentials"
          :key="'line-' + cred.said"
          :x1="lineStartX(cred, idx)"
          :y1="lineStartY(cred, idx)"
          :x2="lineEndX(cred, idx)"
          :y2="lineEndY(cred, idx)"
          :stroke="isIssuedByMe(cred) ? '#e57e24' : 'var(--matou-muted-foreground, #9ca3af)'"
          stroke-width="1.5"
          stroke-dasharray="6,4"
          :marker-end="isIssuedByMe(cred) ? 'url(#arrowhead-issued)' : 'url(#arrowhead)'"
        />
      </svg>

      <!-- Center node (You) -->
      <div
        class="graph-node center-node"
        :style="{ left: centerX + 'px', top: centerY + 'px' }"
      >
        <div class="node-circle you">
          <img v-if="myAvatarUrl" :src="myAvatarUrl" alt="You" class="node-avatar" />
          <span v-else>You</span>
        </div>
        <div class="node-tooltip">
          <span class="tooltip-name">{{ myDisplayName }}</span>
          <span class="tooltip-aid">{{ truncateAid(identityStore.aidPrefix || '') }}</span>
        </div>
      </div>

      <!-- Counterparty nodes (issuer for received, issuee for issued) -->
      <div
        v-for="(cred, idx) in walletStore.credentials"
        :key="'node-' + cred.said"
        class="graph-node issuer-node"
        :style="{ left: outerNodeX(idx) + 'px', top: outerNodeY(idx) + 'px' }"
      >
        <div class="node-circle issuer" :class="isOrgIssuer(counterpartyAid(cred)) ? '' : issuerAvatarColor(counterpartyAid(cred))">
          <img v-if="isOrgIssuer(counterpartyAid(cred))" src="../../assets/images/matou-bird-logo-blue.svg" alt="Matou" class="node-logo" />
          <img v-else-if="issuerAvatarUrl(counterpartyAid(cred))" :src="issuerAvatarUrl(counterpartyAid(cred))" :alt="isIssuedByMe(cred) ? 'Recipient' : 'Issuer'" class="node-avatar" />
          <span v-else class="node-initials">{{ issuerInitials(counterpartyAid(cred)) }}</span>
        </div>
        <span class="node-label">{{ issuerDisplayName(counterpartyAid(cred)) }}</span>
        <div class="node-tooltip">
          <span class="tooltip-name">{{ issuerDisplayName(counterpartyAid(cred)) }}</span>
          <span class="tooltip-aid">{{ truncateAid(counterpartyAid(cred)) }}</span>
        </div>
      </div>

      <!-- Credential icons on edges (clickable) -->
      <div
        v-for="(cred, idx) in walletStore.credentials"
        :key="'cred-icon-' + cred.said"
        class="edge-cred-icon"
        :style="{
          left: (centerX + outerNodeX(idx)) / 2 + 'px',
          top: (centerY + outerNodeY(idx)) / 2 + 'px',
        }"
        @click="selectedCredential = cred"
      >
        <div class="edge-icon-circle">
          <ShieldCheck :size="22" />
        </div>
        <div class="edge-tooltip">
          <span class="tooltip-name">{{ cred.schemaTitle || cred.role || 'Credential' }}</span>
          <span class="tooltip-aid">{{ cred.said }}</span>
        </div>
      </div>
    </div>

    <!-- Detail dialog -->
    <CredentialDetailDialog
      v-if="selectedCredential"
      :credential="selectedCredential"
      @close="selectedCredential = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  LayoutGrid,
  Network,
  Loader2,
  AlertCircle,
  ShieldOff,
  ShieldCheck,
} from 'lucide-vue-next';
import { useWalletStore } from 'stores/wallet';
import type { WalletCredential } from 'stores/wallet';
import { useProfilesStore } from 'stores/profiles';
import { useIdentityStore } from 'stores/identity';
import { useAppStore } from 'stores/app';
import { getFileUrl } from 'src/lib/api/client';
import CredentialDetailDialog from './CredentialDetailDialog.vue';

const walletStore = useWalletStore();
const profilesStore = useProfilesStore();
const identityStore = useIdentityStore();
const appStore = useAppStore();

const viewMode = ref<'cards' | 'graph'>('cards');
const selectedCredential = ref<WalletCredential | null>(null);

// Graph layout — responsive to container size
const graphContainer = ref<HTMLElement | null>(null);
const graphWidth = ref(600);
const graphHeight = ref(400);
const centerX = computed(() => graphWidth.value / 2);
const centerY = computed(() => graphHeight.value / 2);
const graphRadius = computed(() => Math.min(graphWidth.value, graphHeight.value) * 0.32);
const nodeRadius = 42; // half of center node size (84px)

let resizeObserver: ResizeObserver | null = null;

function updateGraphSize() {
  if (graphContainer.value) {
    graphWidth.value = graphContainer.value.clientWidth;
    graphHeight.value = graphContainer.value.clientHeight;
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateGraphSize);
  if (graphContainer.value) resizeObserver.observe(graphContainer.value);
});

watch(graphContainer, (el) => {
  if (el && resizeObserver) {
    resizeObserver.observe(el);
    updateGraphSize();
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

function outerNodeX(idx: number): number {
  const count = walletStore.credentials.length;
  const angle = (2 * Math.PI * idx) / Math.max(count, 1) - Math.PI / 2;
  return centerX.value + graphRadius.value * Math.cos(angle);
}

function outerNodeY(idx: number): number {
  const count = walletStore.credentials.length;
  const angle = (2 * Math.PI * idx) / Math.max(count, 1) - Math.PI / 2;
  return centerY.value + graphRadius.value * Math.sin(angle);
}

const outerNodeRadius = 36; // half of outer node size (72px)

/** Arrow stop offset: shorten line so arrowhead doesn't overlap the target circle */
function shortenToward(fromX: number, fromY: number, toX: number, toY: number, margin: number) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return { x: toX, y: toY };
  return { x: toX - (dx / dist) * margin, y: toY - (dy / dist) * margin };
}

// Line direction: received → outer-to-center, issued → center-to-outer
function lineStartX(cred: WalletCredential, idx: number): number {
  return isIssuedByMe(cred) ? centerX.value : outerNodeX(idx);
}
function lineStartY(cred: WalletCredential, idx: number): number {
  return isIssuedByMe(cred) ? centerY.value : outerNodeY(idx);
}
function lineEndX(cred: WalletCredential, idx: number): number {
  if (isIssuedByMe(cred)) {
    return shortenToward(centerX.value, centerY.value, outerNodeX(idx), outerNodeY(idx), outerNodeRadius).x;
  }
  return shortenToward(outerNodeX(idx), outerNodeY(idx), centerX.value, centerY.value, nodeRadius).x;
}
function lineEndY(cred: WalletCredential, idx: number): number {
  if (isIssuedByMe(cred)) {
    return shortenToward(centerX.value, centerY.value, outerNodeX(idx), outerNodeY(idx), outerNodeRadius).y;
  }
  return shortenToward(outerNodeX(idx), outerNodeY(idx), centerX.value, centerY.value, nodeRadius).y;
}

// --- Profile lookups ---

function findProfileByAid(aid: string): Record<string, unknown> | null {
  const profile = profilesStore.communityProfiles.find(
    p => p.ownerKey === aid || (p.data as Record<string, unknown>)?.aid === aid
  );
  return profile ? (profile.data as Record<string, unknown>) : null;
}

function issuerAvatarUrl(aid: string): string {
  const profile = findProfileByAid(aid);
  const avatar = profile?.avatar as string;
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('data:')) return avatar;
  return getFileUrl(avatar);
}

function issuerDisplayName(aid: string): string {
  if (isOrgIssuer(aid)) return 'MĀTOU';
  const profile = findProfileByAid(aid);
  return (profile?.displayName as string) || truncateAid(aid);
}

function issuerInitials(aid: string): string {
  const name = issuerDisplayName(aid);
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

const avatarColors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
function issuerAvatarColor(aid: string): string {
  const name = issuerDisplayName(aid);
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return avatarColors[hash % avatarColors.length];
}

// Current user avatar
const mySharedProfile = computed(() => {
  const sp = profilesStore.getMyProfile('SharedProfile');
  return sp ? (sp.data as Record<string, unknown>) : null;
});

const myAvatarUrl = computed(() => {
  const avatar = mySharedProfile.value?.avatar as string;
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('data:')) return avatar;
  return getFileUrl(avatar);
});

const myDisplayName = computed(() => {
  return (mySharedProfile.value?.displayName as string) || 'You';
});

const myInitials = computed(() => {
  const name = myDisplayName.value;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

function truncateAid(aid: string): string {
  if (!aid || aid.length < 16) return aid || '';
  return aid.substring(0, 8) + '...' + aid.substring(aid.length - 4);
}

function isOrgIssuer(aid: string): boolean {
  return !!appStore.orgAid && aid === appStore.orgAid;
}

function isMatouCredential(cred: WalletCredential): boolean {
  return (cred.schemaTitle || '').toLowerCase().includes('matou');
}

function isIssuedByMe(cred: WalletCredential): boolean {
  const myAid = identityStore.currentAID?.prefix || identityStore.aidPrefix;
  return !!myAid && cred.issueeAid !== myAid;
}

/** For graph: the "other party" AID — issuee for issued creds, issuer for received */
function counterpartyAid(cred: WalletCredential): string {
  return isIssuedByMe(cred) ? cred.issueeAid : cred.issuerAid;
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'issued' || s === 'valid' || s === '0') return 'status-active';
  if (s === 'revoked' || s === '1') return 'status-revoked';
  return 'status-pending';
}

function statusLabel(status: string): string {
  const s = status.toLowerCase();
  if (s === '0' || s === 'issued' || s === 'valid') return 'Active';
  if (s === '1' || s === 'revoked') return 'Revoked';
  return status || 'Pending';
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
</script>

<style scoped>
.credentials-tab {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.view-toggle {
  display: flex;
  gap: 0.5rem;
}

.toggle-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  color: var(--matou-muted-foreground, #6b7280);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.toggle-btn:hover {
  border-color: var(--matou-primary, #1e5f74);
  color: var(--matou-foreground, #1f2937);
}

.toggle-btn.active {
  background: var(--matou-primary, #1e5f74);
  border-color: var(--matou-primary, #1e5f74);
  color: var(--matou-primary-foreground, white);
}

/* Loading / Error / Empty states */
.loading-state,
.error-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
  color: var(--matou-muted-foreground, #6b7280);
  text-align: center;
}

.loading-state {
  flex-direction: row;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-state {
  color: var(--matou-destructive, #c8463a);
}

.empty-state h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
}

.empty-state p {
  margin: 0;
  font-size: 0.875rem;
}

/* Card grid – single column so each card is full width */
.cards-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

.credential-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  padding: 1.25rem;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.credential-card:hover {
  border-color: var(--matou-primary, #1e5f74);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.credential-card.card-issued {
  border-left: 3px solid #e57e24;
}

.credential-card.card-issued:hover {
  border-color: #e57e24;
  border-left: 3px solid #e57e24;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-top-right {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.direction-badge {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.direction-received {
  background: #e8f4f8;
  color: var(--matou-primary, #1e5f74);
}

.direction-issued {
  background: #fef3e6;
  color: #e57e24;
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 0.5rem;
  background: linear-gradient(135deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.card-icon.matou-icon {
  background: white;
  border: 1px solid var(--matou-border, #e5e7eb);
}

.matou-logo {
  width: 22px;
  height: 22px;
}

.status-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.2rem 0.625rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.status-active {
  background: #ecfdf5;
  color: #059669;
}

.status-revoked {
  background: #fef2f2;
  color: #dc2626;
}

.status-pending {
  background: #fffbeb;
  color: #d97706;
}

.card-body {
  flex: 1;
}

.card-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
}

.card-role {
  margin: 0.125rem 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--matou-foreground, #374151);
}

.card-community {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.card-recipient {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #e57e24;
}

.card-footer {
  display: flex;
  justify-content: flex-end;
}

.card-date {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #9ca3af);
}

/* Graph view */
.graph-view {
  position: relative;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  overflow: hidden;
  min-height: 800px;
}

.graph-svg {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.graph-node {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  z-index: 1;
}

.node-circle {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 600;
  color: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}

.node-circle.you {
  background: linear-gradient(135deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
  width: 84px;
  height: 84px;
  font-size: 1.0625rem;
}

.node-circle.issuer {
  background: var(--matou-secondary, #e8f4f8);
  color: var(--matou-primary, #1e5f74);
  cursor: default;
  transition: transform 0.15s ease;
}

.node-circle.issuer.gradient-1 { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.node-circle.issuer.gradient-2 { background: linear-gradient(135deg, #ec4899, #f43f5e); }
.node-circle.issuer.gradient-3 { background: linear-gradient(135deg, #14b8a6, #06b6d4); }
.node-circle.issuer.gradient-4 { background: linear-gradient(135deg, rgba(30, 95, 116, 0.8), rgba(74, 157, 156, 0.8)); }

.node-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.node-initials {
  font-size: 1.0625rem;
  font-weight: 600;
  color: white;
}

.node-logo {
  width: 38px;
  height: 38px;
}

.node-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--matou-foreground, #1f2937);
  white-space: nowrap;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Hover tooltip — appears to the right of the node */
.node-tooltip {
  display: none;
  position: absolute;
  top: 50%;
  left: calc(100% + 0.5rem);
  transform: translateY(-50%);
  background: var(--matou-foreground, #1f2937);
  color: white;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  white-space: nowrap;
  z-index: 100;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.graph-node:hover .node-tooltip {
  display: flex;
}

.tooltip-name {
  font-size: 0.75rem;
  font-weight: 600;
}

.tooltip-aid {
  font-size: 0.625rem;
  font-family: monospace;
  opacity: 0.7;
}

/* Credential icon on edge */
.edge-cred-icon {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 2;
  cursor: pointer;
}

.edge-icon-circle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--matou-secondary, #e8f4f8);
  border: 1px solid var(--matou-border, #e5e7eb);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--matou-primary, #1e5f74);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  transition: transform 0.15s ease;
}

.edge-cred-icon:hover .edge-icon-circle {
  transform: scale(1.15);
}

.edge-tooltip {
  display: none;
  position: absolute;
  top: 50%;
  left: calc(100% + 0.5rem);
  transform: translateY(-50%);
  background: var(--matou-foreground, #1f2937);
  color: white;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  white-space: nowrap;
  z-index: 100;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.edge-cred-icon:hover .edge-tooltip {
  display: flex;
}
</style>
