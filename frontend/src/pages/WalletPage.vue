<template>
  <div class="wallet-page">
    <div class="wallet-body">
      <!-- Wallet sidebar (same style as main dashboard nav) -->
      <aside class="wallet-sidebar">
        <div class="wallet-sidebar-header">
          <h2 class="wallet-sidebar-title">Wallet</h2>
          <p class="wallet-sidebar-subtitle">Your identity credentials and community tokens stored in your wallet</p>
        </div>
        <nav class="wallet-sidebar-nav">
          <button
            class="wallet-nav-item"
            :class="{ active: activeTab === 'credentials' }"
            @click="activeTab = 'credentials'"
          >
            <span class="wallet-nav-text">
              <span class="wallet-nav-label">Credentials</span>
              <span class="wallet-nav-badge">ID</span>
            </span>
          </button>
          <button
            class="wallet-nav-item"
            :class="{ active: activeTab === 'governance' }"
            @click="activeTab = 'governance'"
          >
            <span class="wallet-nav-text">
              <span class="wallet-nav-label">Governance Tokens</span>
              <span class="wallet-nav-badge">GOV</span>
            </span>
          </button>
          <button
            class="wallet-nav-item"
            :class="{ active: activeTab === 'tokens' }"
            @click="activeTab = 'tokens'"
          >
            <span class="wallet-nav-text">
              <span class="wallet-nav-label">Transaction Tokens</span>
              <span class="wallet-nav-badge">UTIL</span>
            </span>
          </button>
        </nav>
      </aside>

      <!-- Tab content -->
      <div class="tab-content">
        <CredentialsTab v-if="activeTab === 'credentials'" />
        <GovernanceTokensTab v-if="activeTab === 'governance'" />
        <TransactionTokensTab v-if="activeTab === 'tokens'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ShieldCheck, Vote, Coins } from 'lucide-vue-next';
import { useWalletStore } from 'stores/wallet';
import CredentialsTab from 'src/components/wallet/CredentialsTab.vue';
import GovernanceTokensTab from 'src/components/wallet/GovernanceTokensTab.vue';
import TransactionTokensTab from 'src/components/wallet/TransactionTokensTab.vue';

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

.wallet-body {
  flex: 1;
  min-height: 0;
  margin-left: 220px;
}

/* Wallet sidebar – fixed, full height, same styling as main dashboard sidebar */
.wallet-sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 240px; /* after main dashboard sidebar */
  width: 220px;
  height: 100%;
  padding-top: 40px;
  border-right: 1px solid var(--matou-sidebar-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.wallet-sidebar-header {
  padding: 1.25rem 1rem;
}

.wallet-sidebar-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--matou-sidebar-foreground);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.wallet-sidebar-subtitle {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  margin: 0.25rem 0 0;
  line-height: 1.3;
}

.wallet-sidebar-nav {
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.wallet-nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  font-size: 1rem;
  font-weight: 500;
  color: var(--matou-sidebar-foreground);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all 0.15s ease;
  border-radius: 0 10px 10px 0;
}

.wallet-nav-item:hover {
  background-color: var(--matou-sidebar-accent);
}

.wallet-nav-item.active {
  background-color: var(--matou-sidebar-accent);
  color: var(--matou-sidebar-primary);
  border-left: 3px solid var(--matou-sidebar-primary);
  margin-left: 0;
  padding-left: calc(0.75rem - 3px);
}


.wallet-nav-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
}

.wallet-nav-label {
  line-height: 1.2;
}

.wallet-nav-badge {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  font-weight: 400;
}

.wallet-nav-item.active .wallet-nav-badge {
  color: var(--matou-sidebar-primary);
}

.tab-content {
  flex: 1;
  padding: 1.5rem 2rem;
  padding-top: 60px;
  width: 100%;
  overflow-y: auto;
}
</style>
