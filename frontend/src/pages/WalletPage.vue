<template>
  <div class="wallet-page">
    <!-- Header -->
    <div class="wallet-header">
      <button class="back-btn" @click="router.push({ name: 'dashboard' })">
        <ArrowLeft :size="20" />
      </button>
      <div>
        <h1 class="header-title">Wallet</h1>
        <p class="header-subtitle">Credentials, tokens &amp; transactions</p>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'credentials' }"
        @click="activeTab = 'credentials'"
      >
        <ShieldCheck :size="16" />
        Credentials
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'governance' }"
        @click="activeTab = 'governance'"
      >
        <Vote :size="16" />
        Governance
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'tokens' }"
        @click="activeTab = 'tokens'"
      >
        <Coins :size="16" />
        Tokens
      </button>
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      <CredentialsTab v-if="activeTab === 'credentials'" />
      <GovernanceTokensTab v-if="activeTab === 'governance'" />
      <TransactionTokensTab v-if="activeTab === 'tokens'" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ArrowLeft, ShieldCheck, Vote, Coins } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { useWalletStore } from 'stores/wallet';
import CredentialsTab from 'src/components/wallet/CredentialsTab.vue';
import GovernanceTokensTab from 'src/components/wallet/GovernanceTokensTab.vue';
import TransactionTokensTab from 'src/components/wallet/TransactionTokensTab.vue';

const router = useRouter();
const walletStore = useWalletStore();

const activeTab = ref<'credentials' | 'governance' | 'tokens'>('credentials');

onMounted(() => {
  walletStore.refreshAll();
});
</script>

<style scoped>
.wallet-page {
  flex: 1;
  background: var(--matou-background, #f4f4f5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.wallet-header {
  background: linear-gradient(135deg, #1a4f5e, #2a7f8f);
  color: white;
  padding: 1.5rem 2rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.back-btn {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 0.375rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}

.back-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.header-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  line-height: 1.3;
}

.header-subtitle {
  font-size: 0.875rem;
  margin: 0.25rem 0 0;
  opacity: 0.85;
}

.tab-bar {
  display: flex;
  gap: 0;
  background: var(--matou-card, white);
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
  padding: 0 2rem;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.875rem 1.25rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--matou-muted-foreground, #6b7280);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-btn:hover {
  color: var(--matou-foreground, #1f2937);
}

.tab-btn.active {
  color: var(--matou-primary, #1e5f74);
  border-bottom-color: var(--matou-primary, #1e5f74);
}

.tab-content {
  flex: 1;
  padding: 1.5rem 2rem;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
}
</style>
