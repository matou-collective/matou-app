<template>
  <div class="tokens-tab">
    <!-- Balance card -->
    <div class="balance-card">
      <div class="balance-label">Utility Balance</div>
      <div class="balance-amount">
        {{ walletStore.utilBalance.balance.toFixed(walletStore.utilBalance.decimals) }}
        <span class="balance-symbol">{{ walletStore.utilBalance.symbol }}</span>
      </div>
      <div class="balance-name">{{ walletStore.utilBalance.name }}</div>
    </div>

    <!-- Action buttons -->
    <div class="action-buttons">
      <button
        class="action-btn send-btn"
        :class="{ disabled: walletStore.utilBalance.balance <= 0 }"
        :disabled="walletStore.utilBalance.balance <= 0"
        @click="showSend = true"
      >
        <Send :size="18" />
        <span>Send</span>
      </button>
      <button class="action-btn receive-btn" @click="showReceive = true">
        <Download :size="18" />
        <span>Receive</span>
      </button>
      <button class="action-btn qr-btn" @click="showReceive = true">
        <QrCode :size="18" />
        <span>QR Code</span>
      </button>
    </div>

    <!-- Transaction history -->
    <section class="section-card">
      <h3 class="section-title"><History :size="16" /> Transaction History</h3>
      <div v-if="walletStore.transactions.length > 0" class="tx-list">
        <div
          v-for="tx in walletStore.transactions"
          :key="tx.id"
          class="tx-item"
        >
          <div class="tx-icon" :class="tx.type">
            <ArrowUpRight v-if="tx.type === 'send'" :size="16" />
            <ArrowDownLeft v-else :size="16" />
          </div>
          <div class="tx-info">
            <span class="tx-description">{{ tx.description || (tx.type === 'send' ? 'Sent' : 'Received') }}</span>
            <span class="tx-counterparty">{{ truncateAid(tx.counterparty) }}</span>
          </div>
          <div class="tx-amount" :class="tx.type">
            {{ tx.type === 'send' ? '-' : '+' }}{{ tx.amount.toFixed(2) }} {{ tx.tokenType }}
          </div>
        </div>
      </div>
      <div v-else class="empty-placeholder">
        <ReceiptText :size="20" />
        <span>No transactions yet</span>
      </div>
    </section>

    <!-- Send dialog -->
    <div v-if="showSend" class="dialog-overlay" @click.self="closeSend">
      <div class="dialog-card">
        <div class="dialog-header">
          <h3>Send Tokens</h3>
          <button class="close-btn" @click="closeSend">&times;</button>
        </div>
        <div class="dialog-body">
          <div class="field-group">
            <label class="field-label">Recipient AID</label>
            <input
              type="text"
              class="field-input"
              v-model="sendRecipient"
              placeholder="Enter recipient AID prefix"
            />
          </div>
          <div class="field-group">
            <label class="field-label">Amount ({{ walletStore.utilBalance.symbol }})</label>
            <input
              type="number"
              class="field-input"
              v-model.number="sendAmount"
              placeholder="0.00"
              min="0"
              :max="walletStore.utilBalance.balance"
              step="0.01"
            />
          </div>
          <button
            class="submit-btn"
            :disabled="!sendRecipient || sendAmount <= 0 || sendAmount > walletStore.utilBalance.balance"
          >
            <Send :size="16" />
            Send {{ sendAmount > 0 ? sendAmount.toFixed(2) : '' }} {{ walletStore.utilBalance.symbol }}
          </button>
        </div>
      </div>
    </div>

    <!-- Receive dialog -->
    <div v-if="showReceive" class="dialog-overlay" @click.self="showReceive = false">
      <div class="dialog-card">
        <div class="dialog-header">
          <h3>Receive Tokens</h3>
          <button class="close-btn" @click="showReceive = false">&times;</button>
        </div>
        <div class="dialog-body">
          <p class="receive-info">Share your AID with the sender to receive tokens.</p>
          <div class="field-group">
            <label class="field-label">Your AID</label>
            <div class="aid-box">
              <code class="aid-text">{{ userAid }}</code>
              <button class="copy-btn" @click="copyAid" :title="copied ? 'Copied!' : 'Copy AID'">
                <Check v-if="copied" :size="14" />
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
import {
  Send,
  Download,
  QrCode,
  History,
  ArrowUpRight,
  ArrowDownLeft,
  ReceiptText,
  Copy,
  Check,
} from 'lucide-vue-next';
import { useWalletStore } from 'stores/wallet';
import { useIdentityStore } from 'stores/identity';

const walletStore = useWalletStore();
const identityStore = useIdentityStore();

const showSend = ref(false);
const showReceive = ref(false);
const sendRecipient = ref('');
const sendAmount = ref(0);
const copied = ref(false);

const userAid = computed(() => identityStore.aidPrefix || '—');

function closeSend() {
  showSend.value = false;
  sendRecipient.value = '';
  sendAmount.value = 0;
}

function truncateAid(aid: string): string {
  if (!aid || aid.length < 16) return aid || '—';
  return aid.substring(0, 8) + '...' + aid.substring(aid.length - 4);
}

async function copyAid() {
  const aid = identityStore.aidPrefix;
  if (!aid) return;
  try {
    await navigator.clipboard.writeText(aid);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = aid;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}
</script>

<style scoped>
.tokens-tab {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Balance card */
.balance-card {
  background: linear-gradient(135deg, #2a7f8f, var(--matou-accent, #4a9d9c));
  border-radius: var(--matou-radius, 0.75rem);
  padding: 1.75rem;
  color: white;
}

.balance-label {
  font-size: 0.8125rem;
  opacity: 0.85;
  margin-bottom: 0.5rem;
}

.balance-amount {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 1.2;
}

.balance-symbol {
  font-size: 1.25rem;
  font-weight: 500;
  opacity: 0.85;
}

.balance-name {
  font-size: 0.8125rem;
  opacity: 0.7;
  margin-top: 0.375rem;
}

/* Action buttons */
.action-buttons {
  display: flex;
  gap: 0.75rem;
}

.action-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  padding: 1rem;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  color: var(--matou-foreground, #1f2937);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-btn:hover:not(.disabled) {
  border-color: var(--matou-primary, #1e5f74);
  color: var(--matou-primary, #1e5f74);
}

.action-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Section cards */
.section-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 0.75rem);
  padding: 1.25rem;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
  margin: 0 0 1rem;
}

/* Transaction list */
.tx-list {
  display: flex;
  flex-direction: column;
}

.tx-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
}

.tx-item:last-child {
  border-bottom: none;
}

.tx-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tx-icon.send {
  background: #fef2f2;
  color: #dc2626;
}

.tx-icon.receive {
  background: #ecfdf5;
  color: #059669;
}

.tx-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.tx-description {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground, #1f2937);
}

.tx-counterparty {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #9ca3af);
  font-family: monospace;
}

.tx-amount {
  font-size: 0.9375rem;
  font-weight: 600;
  white-space: nowrap;
}

.tx-amount.send {
  color: #dc2626;
}

.tx-amount.receive {
  color: #059669;
}

/* Empty placeholder */
.empty-placeholder {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 1.25rem;
  color: var(--matou-muted-foreground, #9ca3af);
  font-size: 0.875rem;
}

/* Dialog overlay */
.dialog-overlay {
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

.dialog-card {
  background: var(--matou-card, #fff);
  border-radius: 0.75rem;
  width: 90%;
  max-width: 420px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
}

.dialog-header h3 {
  font-size: 1.0625rem;
  font-weight: 600;
  margin: 0;
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

.receive-info {
  margin: 0;
  font-size: 0.875rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.field-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-muted-foreground, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.field-input {
  background: var(--matou-input-background, #f0f7f9);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
  width: 100%;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--matou-primary, #1e5f74);
  box-shadow: 0 0 0 2px rgba(30, 95, 116, 0.1);
}

.submit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background: var(--matou-primary, #1e5f74);
  color: var(--matou-primary-foreground, white);
  border: none;
  border-radius: var(--matou-radius-xl, 1rem);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease;
}

.submit-btn:hover:not(:disabled) {
  background: rgba(30, 95, 116, 0.9);
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* AID copy box */
.aid-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--matou-input-background, #f0f7f9);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
}

.aid-text {
  font-family: monospace;
  font-size: 0.8rem;
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
