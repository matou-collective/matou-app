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
        @click="selectedCredential = cred"
      >
        <div class="card-top">
          <div class="card-icon">
            <ShieldCheck :size="20" />
          </div>
          <span class="status-badge" :class="statusClass(cred.status)">
            {{ cred.status }}
          </span>
        </div>
        <div class="card-body">
          <h4 class="card-role">{{ cred.role || 'Credential' }}</h4>
          <p class="card-community">{{ cred.communityName || 'Unknown community' }}</p>
        </div>
        <div class="card-footer">
          <span class="card-date">{{ formatDate(cred.issuedAt) }}</span>
        </div>
      </div>
    </div>

    <!-- Relationship graph view -->
    <div v-else class="graph-view" ref="graphContainer">
      <svg :width="graphWidth" :height="graphHeight" class="graph-svg">
        <!-- Connection lines -->
        <line
          v-for="(cred, idx) in walletStore.credentials"
          :key="'line-' + cred.said"
          :x1="centerX"
          :y1="centerY"
          :x2="issuerX(idx)"
          :y2="issuerY(idx)"
          stroke="var(--matou-border, #d1d5db)"
          stroke-width="1.5"
          stroke-dasharray="6,4"
        />
      </svg>

      <!-- Center node (You) -->
      <div
        class="graph-node center-node"
        :style="{ left: centerX + 'px', top: centerY + 'px' }"
      >
        <div class="node-circle you">You</div>
      </div>

      <!-- Issuer nodes -->
      <div
        v-for="(cred, idx) in walletStore.credentials"
        :key="'node-' + cred.said"
        class="graph-node issuer-node"
        :style="{ left: issuerX(idx) + 'px', top: issuerY(idx) + 'px' }"
        @click="selectedCredential = cred"
      >
        <div class="node-circle issuer">
          <ShieldCheck :size="14" />
        </div>
        <span class="node-label">{{ cred.role || 'Issuer' }}</span>
      </div>

      <!-- Edge labels -->
      <div
        v-for="(cred, idx) in walletStore.credentials"
        :key="'label-' + cred.said"
        class="edge-label"
        :style="{
          left: (centerX + issuerX(idx)) / 2 + 'px',
          top: (centerY + issuerY(idx)) / 2 + 'px',
        }"
      >
        {{ cred.communityName || cred.role || 'credential' }}
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
import { ref, computed } from 'vue';
import {
  LayoutGrid,
  Network,
  Loader2,
  AlertCircle,
  ShieldOff,
  ShieldCheck,
} from 'lucide-vue-next';
import { useWalletStore, type WalletCredential } from 'stores/wallet';
import CredentialDetailDialog from './CredentialDetailDialog.vue';

const walletStore = useWalletStore();

const viewMode = ref<'cards' | 'graph'>('cards');
const selectedCredential = ref<WalletCredential | null>(null);

// Graph layout
const graphWidth = 600;
const graphHeight = 400;
const centerX = computed(() => graphWidth / 2);
const centerY = computed(() => graphHeight / 2);
const graphRadius = 150;

function issuerX(idx: number): number {
  const count = walletStore.credentials.length;
  const angle = (2 * Math.PI * idx) / Math.max(count, 1) - Math.PI / 2;
  return centerX.value + graphRadius * Math.cos(angle);
}

function issuerY(idx: number): number {
  const count = walletStore.credentials.length;
  const angle = (2 * Math.PI * idx) / Math.max(count, 1) - Math.PI / 2;
  return centerY.value + graphRadius * Math.sin(angle);
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'issued' || s === 'valid' || s === '0') return 'status-active';
  if (s === 'revoked' || s === '1') return 'status-revoked';
  return 'status-pending';
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

/* Card grid */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
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

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

.card-role {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
}

.card-community {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
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
  min-height: 400px;
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
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.node-circle.you {
  background: linear-gradient(135deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
  width: 52px;
  height: 52px;
  font-size: 0.8125rem;
}

.node-circle.issuer {
  background: var(--matou-secondary, #e8f4f8);
  color: var(--matou-primary, #1e5f74);
  cursor: pointer;
  transition: transform 0.15s ease;
}

.issuer-node:hover .node-circle.issuer {
  transform: scale(1.1);
}

.node-label {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--matou-foreground, #1f2937);
  white-space: nowrap;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edge-label {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 0.65rem;
  color: var(--matou-muted-foreground, #9ca3af);
  background: var(--matou-card, white);
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 2;
}
</style>
