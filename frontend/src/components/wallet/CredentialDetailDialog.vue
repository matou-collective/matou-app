<template>
  <div class="credential-overlay" @click.self="$emit('close')">
    <div class="credential-dialog">
      <!-- Header -->
      <div class="dialog-header">
        <div class="header-left">
          <div class="cred-icon" :class="{ 'matou-icon': isMatouCredential }">
            <img v-if="isMatouCredential" src="../../assets/images/matou-bird-logo-blue.svg" alt="Matou" class="matou-logo" />
            <q-icon v-else :name="iconName" size="22px" />
          </div>
          <div>
            <h2 class="cred-title">{{ title }}</h2>
            <span class="status-badge" :class="statusClass">{{ statusLabel }}</span>
          </div>
        </div>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <!-- Body -->
      <div class="dialog-body">
        <!-- Schema description -->
        <p v-if="credential.schemaDescription" class="schema-description">
          {{ credential.schemaDescription }}
        </p>

        <!-- Membership attributes -->
        <template v-if="isMembership">
          <div class="attr-row" v-if="credential.communityName">
            <span class="attr-label">Community</span>
            <span class="attr-value">{{ credential.communityName }}</span>
          </div>
          <div class="attr-row">
            <span class="attr-label">Role</span>
            <span class="attr-value">{{ credential.role || '—' }}</span>
          </div>
        </template>

        <!-- Endorsement attributes -->
        <template v-else-if="isEndorsement">
          <div class="attr-row" v-if="credential.claim">
            <span class="attr-label">Endorsement</span>
            <span class="attr-value">{{ credential.claim }}</span>
          </div>
        </template>

        <!-- Event attendance attributes -->
        <template v-else-if="isEventAttendance">
          <div class="attr-row" v-if="credential.eventName">
            <span class="attr-label">Event</span>
            <span class="attr-value">{{ credential.eventName }}</span>
          </div>
        </template>

        <div class="attr-row">
          <span class="attr-label">Status</span>
          <span class="attr-value">
            <span class="status-dot" :class="statusClass"></span>
            {{ statusLabel }}
          </span>
        </div>

        <div class="attr-row" v-if="credential.permissions.length">
          <span class="attr-label">Permissions</span>
          <div class="attr-chips">
            <span
              v-for="perm in credential.permissions"
              :key="perm"
              class="chip"
            >{{ perm }}</span>
          </div>
        </div>

        <div class="attr-row" v-if="credential.joinedAt">
          <span class="attr-label">Joined</span>
          <span class="attr-value">{{ formatDate(credential.joinedAt) }}</span>
        </div>

        <div class="attr-row" v-if="credential.issuedAt">
          <span class="attr-label">Issued</span>
          <span class="attr-value">{{ formatDate(credential.issuedAt) }}</span>
        </div>

        <!-- Technical details -->
        <div class="technical-section">
          <h3 class="section-title">Technical Details</h3>

          <div class="tech-row">
            <span class="tech-label">SAID</span>
            <div class="tech-value-row">
              <code class="tech-value">{{ credential.said }}</code>
              <button class="copy-btn" @click="copy(credential.said)" :title="copiedField === 'said' ? 'Copied!' : 'Copy'">
                <Check v-if="copiedField === 'said'" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>
          </div>

          <div class="tech-row">
            <span class="tech-label">Schema SAID</span>
            <div class="tech-value-row">
              <code class="tech-value">{{ credential.schemaSaid }}</code>
              <button class="copy-btn" @click="copy(credential.schemaSaid, 'schema')" :title="copiedField === 'schema' ? 'Copied!' : 'Copy'">
                <Check v-if="copiedField === 'schema'" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>
          </div>

          <div class="tech-row">
            <span class="tech-label">Issuer AID</span>
            <div class="tech-value-row">
              <code class="tech-value">{{ credential.issuerAid }}</code>
              <button class="copy-btn" @click="copy(credential.issuerAid, 'issuer')" :title="copiedField === 'issuer' ? 'Copied!' : 'Copy'">
                <Check v-if="copiedField === 'issuer'" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>
          </div>
        </div>

        <!-- Revoke action -->
        <div v-if="isIssuedByMe && isActive" class="revoke-section">
          <template v-if="!showRevokeConfirm">
            <button class="revoke-btn" @click="showRevokeConfirm = true">Revoke Credential</button>
          </template>
          <template v-else>
            <p class="revoke-warning">This will permanently revoke this credential. This action cannot be undone.</p>
            <div class="revoke-actions">
              <button class="revoke-cancel-btn" @click="showRevokeConfirm = false" :disabled="revoking">Cancel</button>
              <button class="revoke-confirm-btn" @click="handleRevoke" :disabled="revoking">
                <Loader2 v-if="revoking" :size="14" class="spinner" />
                {{ revoking ? 'Revoking...' : 'Confirm Revoke' }}
              </button>
            </div>
            <p v-if="revokeError" class="revoke-error">{{ revokeError }}</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Copy, Check, Loader2 } from 'lucide-vue-next';
import type { WalletCredential } from 'stores/wallet';
import { useWalletStore } from 'stores/wallet';
import { useIdentityStore } from 'stores/identity';
import {
  ENDORSEMENT_SCHEMA_SAID,
  EVENT_ATTENDANCE_SCHEMA_SAID,
} from 'src/composables/useAdminActions';

const props = defineProps<{
  credential: WalletCredential;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const walletStore = useWalletStore();
const identityStore = useIdentityStore();

const copiedField = ref<string | null>(null);
const showRevokeConfirm = ref(false);
const revoking = ref(false);
const revokeError = ref<string | null>(null);

const isIssuedByMe = computed(() => {
  const myAid = identityStore.currentAID?.prefix || identityStore.aidPrefix;
  return !!myAid && props.credential.issuerAid === myAid;
});

const isActive = computed(() => {
  const s = props.credential.status.toLowerCase();
  return s === '0' || s === 'issued' || s === 'valid';
});

async function handleRevoke() {
  revoking.value = true;
  revokeError.value = null;
  try {
    await walletStore.revokeCredential(props.credential.said);
    emit('close');
  } catch (err) {
    revokeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    revoking.value = false;
  }
}

const isEndorsement = computed(() => props.credential.schemaSaid === ENDORSEMENT_SCHEMA_SAID);
const isEventAttendance = computed(() => props.credential.schemaSaid === EVENT_ATTENDANCE_SCHEMA_SAID);
const isMembership = computed(() => !isEndorsement.value && !isEventAttendance.value);

const isMatouCredential = computed(() => {
  return (props.credential.schemaTitle || '').toLowerCase().includes('matou');
});

const iconName = computed(() => {
  if (isEndorsement.value) return 'person_add';
  if (isEventAttendance.value) return 'event_available';
  return 'groups';
});

const title = computed(() => {
  if (isEndorsement.value) return 'Membership Endorsement';
  if (isEventAttendance.value) return props.credential.eventName || 'Event Attendance';
  return props.credential.schemaTitle || props.credential.role || 'Credential';
});

const statusClass = computed(() => {
  const s = props.credential.status.toLowerCase();
  if (s === 'issued' || s === 'valid' || s === '0') return 'status-active';
  if (s === 'revoked' || s === '1') return 'status-revoked';
  return 'status-pending';
});

const statusLabel = computed(() => {
  const s = props.credential.status.toLowerCase();
  if (s === '0' || s === 'issued' || s === 'valid') return 'Active';
  if (s === '1' || s === 'revoked') return 'Revoked';
  return props.credential.status || 'Pending';
});

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

async function copy(text: string, field = 'said') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copiedField.value = field;
  setTimeout(() => { copiedField.value = null; }, 2000);
}
</script>

<style scoped>
.credential-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.credential-dialog {
  background: var(--matou-card, #fff);
  border-radius: 0.75rem;
  width: 90%;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.cred-icon {
  width: 42px;
  height: 42px;
  border-radius: 0.625rem;
  background: linear-gradient(135deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  flex-shrink: 0;
}

.cred-icon.matou-icon {
  background: white;
  border: 1px solid var(--matou-border, #e5e7eb);
}

.matou-logo {
  width: 26px;
  height: 26px;
}

.cred-title {
  font-size: 1.0625rem;
  font-weight: 600;
  margin: 0 0 0.375rem;
  color: var(--matou-foreground, #1f2937);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: var(--matou-muted-foreground, #6b7280);
  padding: 0;
  line-height: 1;
}

.dialog-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.schema-description {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
  line-height: 1.5;
}

.attr-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.attr-label {
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: var(--matou-muted-foreground, #6b7280);
}

.attr-value {
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.attr-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.chip {
  display: inline-block;
  padding: 0.2rem 0.625rem;
  background: #e0f2f1;
  color: #1a4f5e;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
}

.status-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.2rem 0.625rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.status-active {
  background: #ecfdf5;
  color: #059669;
}

.status-dot.status-active {
  background: #059669;
}

.status-revoked {
  background: #fef2f2;
  color: #dc2626;
}

.status-dot.status-revoked {
  background: #dc2626;
}

.status-pending {
  background: #fffbeb;
  color: #d97706;
}

.status-dot.status-pending {
  background: #d97706;
}

/* Technical section */
.technical-section {
  margin-top: 0.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--matou-border, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
  margin: 0;
}

.tech-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tech-label {
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: var(--matou-muted-foreground, #6b7280);
}

.tech-value-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--matou-input-background, #f0f7f9);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}

.tech-value {
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--matou-foreground, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--matou-primary, #1e5f74);
  padding: 0.25rem;
  border-radius: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease;
}

.copy-btn:hover {
  background: rgba(26, 79, 94, 0.1);
}

/* Revoke section */
.revoke-section {
  margin-top: 0.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--matou-border, #e5e7eb);
}

.revoke-btn {
  width: 100%;
  padding: 0.625rem 1rem;
  background: transparent;
  border: 1px solid #dc2626;
  border-radius: 0.5rem;
  color: #dc2626;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.revoke-btn:hover {
  background: #fef2f2;
}

.revoke-warning {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: #dc2626;
  line-height: 1.4;
}

.revoke-actions {
  display: flex;
  gap: 0.5rem;
}

.revoke-cancel-btn {
  flex: 1;
  padding: 0.5rem 1rem;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.5rem;
  color: var(--matou-foreground, #1f2937);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.revoke-confirm-btn {
  flex: 1;
  padding: 0.5rem 1rem;
  background: #dc2626;
  border: 1px solid #dc2626;
  border-radius: 0.5rem;
  color: white;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
}

.revoke-confirm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.revoke-error {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: #dc2626;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
