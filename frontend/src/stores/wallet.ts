import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';

// --- Types ---

export interface WalletCredential {
  said: string;
  schemaSaid: string;
  issuerAid: string;
  issueeAid: string;
  communityName: string;
  role: string;
  permissions: string[];
  joinedAt: string;
  issuedAt: string;
  status: string;
}

export interface TokenBalance {
  type: 'GOV' | 'UTIL';
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
}

export interface Transaction {
  id: string;
  type: 'send' | 'receive';
  tokenType: 'GOV' | 'UTIL';
  amount: number;
  counterparty: string;
  description: string;
  timestamp: string;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface VotingRecord {
  id: string;
  proposalTitle: string;
  vote: 'for' | 'against' | 'abstain';
  weight: number;
  timestamp: string;
}

export interface VestingSchedule {
  totalAmount: number;
  vestedAmount: number;
  startDate: string;
  endDate: string;
  cliffDate: string;
  nextVestingDate: string;
}

// --- Store ---

export const useWalletStore = defineStore('wallet', () => {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // Credentials
  const credentials = ref<WalletCredential[]>([]);
  const credentialsLoading = ref(false);
  const credentialsError = ref<string | null>(null);

  // Token balances
  const govBalance = ref<TokenBalance>({
    type: 'GOV',
    symbol: 'GOV',
    name: 'Governance Token',
    balance: 0,
    decimals: 2,
  });

  const utilBalance = ref<TokenBalance>({
    type: 'UTIL',
    symbol: 'UTIL',
    name: 'Utility Token',
    balance: 0,
    decimals: 2,
  });

  // Transactions
  const transactions = ref<Transaction[]>([]);

  // Governance
  const votingHistory = ref<VotingRecord[]>([]);
  const vestingSchedule = ref<VestingSchedule | null>(null);

  // --- Actions ---

  function mapRawCredential(cred: Record<string, unknown>): WalletCredential {
    const sad = cred.sad as Record<string, unknown> | undefined;
    const attrs = (sad?.a || {}) as Record<string, unknown>;
    const statusObj = cred.status as Record<string, unknown> | undefined;

    return {
      said: (sad?.d as string) || '',
      schemaSaid: (sad?.s as string) || '',
      issuerAid: (sad?.i as string) || '',
      issueeAid: (attrs.i as string) || identityStore.currentAID?.prefix || '',
      communityName: (attrs.communityName as string) || '',
      role: (attrs.role as string) || '',
      permissions: (attrs.permissions as string[]) || [],
      joinedAt: (attrs.joinedAt as string) || '',
      issuedAt: (attrs.dt as string) || '',
      status: (statusObj?.s as string) || 'unknown',
    };
  }

  async function loadCredentials(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      credentialsError.value = 'Not connected to KERIA';
      return;
    }

    credentialsLoading.value = true;
    credentialsError.value = null;

    try {
      const rawCredentials = await client.credentials().list();
      console.log('[WalletStore] Loaded credentials:', rawCredentials.length);
      credentials.value = rawCredentials.map((c: unknown) =>
        mapRawCredential(c as Record<string, unknown>)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[WalletStore] Failed to load credentials:', err);
      credentialsError.value = msg;
    } finally {
      credentialsLoading.value = false;
    }
  }

  async function refreshAll(): Promise<void> {
    await loadCredentials();
  }

  return {
    // State
    credentials,
    credentialsLoading,
    credentialsError,
    govBalance,
    utilBalance,
    transactions,
    votingHistory,
    vestingSchedule,

    // Actions
    loadCredentials,
    refreshAll,
  };
});
