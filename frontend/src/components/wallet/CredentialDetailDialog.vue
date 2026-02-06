<template>
  <div class="credential-overlay" @click.self="$emit('close')">
    <div class="credential-dialog">
      <!-- Header -->
      <div class="dialog-header">
        <div class="header-left">
          <div class="cred-icon">
            <ShieldCheck :size="22" />
          </div>
          <div>
            <h2 class="cred-title">{{ credential.role || 'Credential' }}</h2>
            <span class="status-badge" :class="statusClass">{{ credential.status }}</span>
          </div>
        </div>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <!-- Body -->
      <div class="dialog-body">
        <!-- Attribute rows -->
        <div class="attr-row" v-if="credential.communityName">
          <span class="attr-label">Community</span>
          <span class="attr-value">{{ credential.communityName }}</span>
        </div>

        <div class="attr-row">
          <span class="attr-label">Role</span>
          <span class="attr-value">{{ credential.role || '—' }}</span>
        </div>

        <div class="attr-row">
          <span class="attr-label">Verification Status</span>
          <span class="attr-value">
            <span class="status-dot" :class="statusClass"></span>
            {{ credential.status }}
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ShieldCheck, Copy, Check } from 'lucide-vue-next';
import type { WalletCredential } from 'stores/wallet';

const props = defineProps<{
  credential: WalletCredential;
}>();

defineEmits<{
  (e: 'close'): void;
}>();

const copiedField = ref<string | null>(null);

const statusClass = computed(() => {
  const s = props.credential.status.toLowerCase();
  if (s === 'issued' || s === 'valid' || s === '0') return 'status-active';
  if (s === 'revoked' || s === '1') return 'status-revoked';
  return 'status-pending';
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
</style>
