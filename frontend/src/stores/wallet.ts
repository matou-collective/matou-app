import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { toWalletCredential, type WalletCredential } from 'src/lib/walletCredential';

// --- Types ---

// The credential's shape and its mapping from the agent's raw record live in
// `src/lib/walletCredential`, shared with the sign-in approve card (#683).
export type { WalletCredential };

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

  function mapRawCredential(
    cred: Record<string, unknown>,
    schemaMap: Map<string, { title: string; description: string }>,
  ): WalletCredential {
    return toWalletCredential(cred, schemaMap, identityStore.currentAID?.prefix || '');
  }

  async function fetchSchemas(
    client: ReturnType<typeof keriClient.getSignifyClient> & object,
    schemaSaids: string[],
  ): Promise<Map<string, { title: string; description: string }>> {
    const schemaMap = new Map<string, { title: string; description: string }>();
    await Promise.all(
      schemaSaids.map(async (said) => {
        try {
          const schema = await (client as any).schemas().get(said);
          schemaMap.set(said, {
            title: schema?.title || '',
            description: schema?.description || '',
          });
        } catch (err) {
          console.warn(`[WalletStore] Failed to fetch schema ${said}:`, err);
        }
      }),
    );
    return schemaMap;
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

      // Collect unique schema SAIDs and fetch their metadata
      const schemaSaids = [
        ...new Set(
          rawCredentials
            .map((c: any) => c.sad?.s as string)
            .filter(Boolean),
        ),
      ];
      const schemaMap = await fetchSchemas(client, schemaSaids);

      credentials.value = rawCredentials.map((c: unknown) =>
        mapRawCredential(c as Record<string, unknown>, schemaMap)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[WalletStore] Failed to load credentials:', err);
      credentialsError.value = msg;
    } finally {
      credentialsLoading.value = false;
    }
  }

  async function revokeCredential(said: string): Promise<void> {
    const aidName = identityStore.currentAID?.name;
    if (!aidName) throw new Error('No active AID');
    await keriClient.revokeCredential(aidName, said);
    // Update local state immediately so UI reflects the revocation
    const cred = credentials.value.find((c) => c.said === said);
    if (cred) cred.status = '1';
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
    revokeCredential,
    refreshAll,
  };
});
