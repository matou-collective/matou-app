<template>
  <div class="governance-tab">
    <!-- Balance card -->
    <div class="balance-card">
      <div class="balance-label">Governance Balance</div>
      <div class="balance-amount">
        {{ walletStore.govBalance.balance.toFixed(walletStore.govBalance.decimals) }}
        <span class="balance-symbol">{{ walletStore.govBalance.symbol }}</span>
      </div>
      <div class="balance-name">{{ walletStore.govBalance.name }}</div>
    </div>

    <!-- Vesting progress -->
    <section class="section-card">
      <h3 class="section-title"><Clock :size="16" /> Vesting Schedule</h3>
      <div v-if="walletStore.vestingSchedule" class="vesting-info">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: vestingPercent + '%' }"></div>
        </div>
        <div class="vesting-details">
          <span>{{ walletStore.vestingSchedule.vestedAmount }} / {{ walletStore.vestingSchedule.totalAmount }} GOV vested</span>
        </div>
      </div>
      <div v-else class="empty-placeholder">
        <CalendarOff :size="20" />
        <span>No vesting schedule</span>
      </div>
    </section>

    <!-- Voting power -->
    <section class="section-card">
      <h3 class="section-title"><Vote :size="16" /> Voting Power</h3>
      <div class="info-box">
        <p>Your voting power is determined by your GOV token balance. Each token equals one vote in community proposals.</p>
        <div class="power-stat">
          <span class="power-value">{{ walletStore.govBalance.balance.toFixed(0) }}</span>
          <span class="power-label">votes available</span>
        </div>
      </div>
    </section>

    <!-- Voting history -->
    <section class="section-card">
      <h3 class="section-title"><History :size="16" /> Voting History</h3>
      <div v-if="walletStore.votingHistory.length > 0" class="voting-list">
        <div v-for="record in walletStore.votingHistory" :key="record.id" class="voting-item">
          <span class="vote-proposal">{{ record.proposalTitle }}</span>
          <span class="vote-choice" :class="'vote-' + record.vote">{{ record.vote }}</span>
        </div>
      </div>
      <div v-else class="empty-placeholder">
        <ArchiveX :size="20" />
        <span>No voting history yet</span>
      </div>
    </section>

    <!-- Achievements -->
    <section class="section-card">
      <h3 class="section-title"><Award :size="16" /> Achievements</h3>
      <div class="empty-placeholder">
        <Trophy :size="20" />
        <span>No achievements yet</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  Clock,
  CalendarOff,
  Vote,
  History,
  ArchiveX,
  Award,
  Trophy,
} from 'lucide-vue-next';
import { useWalletStore } from 'stores/wallet';

const walletStore = useWalletStore();

const vestingPercent = computed(() => {
  const v = walletStore.vestingSchedule;
  if (!v || v.totalAmount === 0) return 0;
  return Math.min(100, (v.vestedAmount / v.totalAmount) * 100);
});
</script>

<style scoped>
.governance-tab {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Balance card */
.balance-card {
  background: linear-gradient(135deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
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

/* Vesting progress */
.progress-bar {
  height: 8px;
  background: var(--matou-secondary, #e8f4f8);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--matou-primary, #1e5f74), var(--matou-accent, #4a9d9c));
  border-radius: 999px;
  transition: width 0.3s ease;
}

.vesting-details {
  margin-top: 0.5rem;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

/* Info box */
.info-box {
  background: var(--matou-input-background, #f0f7f9);
  border-radius: 0.5rem;
  padding: 1rem;
}

.info-box p {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
  line-height: 1.5;
}

.power-stat {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.power-value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--matou-primary, #1e5f74);
}

.power-label {
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
}

/* Voting history */
.voting-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.voting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
}

.voting-item:last-child {
  border-bottom: none;
}

.vote-proposal {
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
}

.vote-choice {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.2rem 0.625rem;
  border-radius: 999px;
  text-transform: uppercase;
}

.vote-for { background: #ecfdf5; color: #059669; }
.vote-against { background: #fef2f2; color: #dc2626; }
.vote-abstain { background: #f3f4f6; color: #6b7280; }

/* Empty placeholder */
.empty-placeholder {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 1.25rem;
  color: var(--matou-muted-foreground, #9ca3af);
  font-size: 0.875rem;
}
</style>
