<template>
  <div
    class="credential-issuance-screen h-full flex flex-col items-center justify-center gradient-secondary p-8 md:p-12"
  >
    <div v-motion="fadeScale()" class="flex flex-col items-center gap-6 max-w-sm text-center">
      <!-- Issuing State -->
      <template v-if="status === 'issuing'">
        <div v-motion="rotate" class="icon-container bg-primary/10 p-6 md:p-8 rounded-3xl">
          <Shield class="w-16 h-16 md:w-20 md:h-20 text-primary" />
        </div>

        <div>
          <h2 class="mb-2">{{ statusMessage }}</h2>
          <p class="text-muted-foreground">{{ statusDescription }}</p>
        </div>

        <div class="flex gap-2">
          <div
            v-for="i in 3"
            :key="i"
            v-motion="loadingDot(i - 1)"
            class="loading-dot w-2 h-2 bg-primary rounded-full"
          />
        </div>
      </template>

      <!-- Syncing State -->
      <template v-else-if="status === 'syncing'">
        <div v-motion="rotate" class="icon-container bg-accent/10 p-6 md:p-8 rounded-3xl">
          <Cloud class="w-16 h-16 md:w-20 md:h-20 text-accent" />
        </div>

        <div>
          <h2 class="mb-2">Syncing to Network</h2>
          <p class="text-muted-foreground">Synchronizing your credentials with the Matou network...</p>
        </div>

        <div class="flex gap-2">
          <div
            v-for="i in 3"
            :key="i"
            v-motion="loadingDot(i - 1)"
            class="loading-dot w-2 h-2 bg-accent rounded-full"
          />
        </div>
      </template>

      <!-- Success State -->
      <template v-else-if="status === 'success'">
        <div v-motion="springBounce" class="icon-container bg-accent/10 p-6 md:p-8 rounded-3xl">
          <CheckCircle2 class="w-16 h-16 md:w-20 md:h-20 text-accent" />
        </div>

        <div>
          <h2 class="mb-2">Credential Issued!</h2>
          <p class="text-muted-foreground mb-4">
            Your Matou membership credential has been successfully created and stored in your
            wallet.
          </p>
        </div>

        <!-- Credential Card -->
        <div class="credential-card w-full bg-card border border-border rounded-xl p-4 md:p-5 text-left">
          <div class="flex items-center gap-3 mb-3">
            <div class="icon-box bg-accent/10 p-2 rounded-lg">
              <Shield class="w-5 h-5 text-accent" />
            </div>
            <div>
              <h4>Matou Member</h4>
              <p class="text-sm text-muted-foreground">Verified Credential</p>
            </div>
          </div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between">
              <span class="text-muted-foreground">Holder:</span>
              <code class="text-xs">{{ truncatedAID }}</code>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">Issued:</span>
              <span>{{ formattedDate }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">Status:</span>
              <span class="text-accent">Active</span>
            </div>
            <div v-if="syncResult" class="flex justify-between">
              <span class="text-muted-foreground">Synced:</span>
              <span :class="syncResult.success ? 'text-accent' : 'text-yellow-600'">
                {{ syncResult.success ? 'Yes' : 'Offline' }}
              </span>
            </div>
          </div>
        </div>

        <!-- Offline Warning -->
        <div
          v-if="syncResult && !syncResult.success"
          class="offline-warning bg-yellow-500/10 text-yellow-700 p-3 rounded-lg text-sm text-left w-full"
        >
          <div class="flex items-start gap-2">
            <AlertCircle class="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <strong>Offline Mode:</strong> Your credential was created locally. It will sync to the network when the backend becomes available.
            </div>
          </div>
        </div>

        <MBtn class="w-full" @click="onComplete"> Enter Matou </MBtn>
      </template>

      <!-- Error State -->
      <template v-else>
        <div v-motion="springBounce" class="icon-container bg-destructive/10 p-6 md:p-8 rounded-3xl">
          <AlertCircle class="w-16 h-16 md:w-20 md:h-20 text-destructive" />
        </div>

        <div>
          <h2 class="mb-2">Something Went Wrong</h2>
          <p class="text-muted-foreground mb-4">
            {{ errorMessage }}
          </p>
        </div>

        <MBtn class="w-full" variant="outline" @click="retry"> Try Again </MBtn>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Shield, CheckCircle2, Cloud, AlertCircle } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { useIdentityStore } from 'stores/identity';
import { syncCredentials, healthCheck, type SyncCredentialsResponse } from 'src/lib/api/client';

const { fadeScale, rotate, loadingDot, springBounce } = useAnimationPresets();
const identityStore = useIdentityStore();

interface Props {
  userAID?: string;
}

const props = withDefaults(defineProps<Props>(), {
  userAID: '',
});

const emit = defineEmits<{
  (e: 'complete'): void;
}>();

const status = ref<'issuing' | 'syncing' | 'success' | 'error'>('issuing');
const statusMessage = ref('Preparing Credential');
const statusDescription = ref('Setting up your membership credential...');
const errorMessage = ref('');
const syncResult = ref<SyncCredentialsResponse | null>(null);

const formattedDate = computed(() => {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
});

const truncatedAID = computed(() => {
  const aid = props.userAID || identityStore.aidPrefix || '';
  if (aid.length > 20) {
    return `${aid.slice(0, 10)}...${aid.slice(-6)}`;
  }
  return aid;
});

async function issueAndSync() {
  const userAid = props.userAID || identityStore.aidPrefix;

  if (!userAid) {
    status.value = 'error';
    errorMessage.value = 'No AID found. Please complete registration first.';
    return;
  }

  try {
    // Step 1: Issue credential (simulated for now - real implementation would use signify-ts)
    status.value = 'issuing';
    statusMessage.value = 'Generating Credential';
    statusDescription.value = 'Creating your verifiable membership credential...';

    // Simulate credential generation
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Step 2: Check backend health and sync
    status.value = 'syncing';
    statusMessage.value = 'Syncing to Network';
    statusDescription.value = 'Synchronizing with the Matou network...';

    const backendAvailable = await healthCheck();

    if (backendAvailable) {
      // Sync to backend
      const mockCredential = {
        type: 'MembershipCredential',
        holder: userAid,
        issuer: 'EMatouOrgAID',
        issuedAt: new Date().toISOString(),
        status: 'active',
      };

      syncResult.value = await syncCredentials({
        userAid,
        credentials: [mockCredential],
      });
    } else {
      // Backend unavailable - offline mode
      syncResult.value = {
        success: false,
        synced: 0,
        failed: 1,
        errors: ['Backend unavailable - running in offline mode'],
      };
    }

    // Step 3: Success
    status.value = 'success';
  } catch (err) {
    console.error('[CredentialIssuance] Error:', err);
    status.value = 'error';
    errorMessage.value = err instanceof Error ? err.message : 'Failed to issue credential';
  }
}

function retry() {
  status.value = 'issuing';
  errorMessage.value = '';
  syncResult.value = null;
  issueAndSync();
}

onMounted(() => {
  issueAndSync();
});

const onComplete = () => {
  emit('complete');
};
</script>

<style lang="scss" scoped>
.credential-issuance-screen {
  background: linear-gradient(
    135deg,
    var(--matou-secondary) 0%,
    var(--matou-background) 50%,
    rgba(232, 244, 248, 0.5) 100%
  );
  min-height: 100vh;
}

.icon-container {
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.credential-card {
  background-color: var(--matou-card);
}

.loading-dot {
  opacity: 0.3;
}

code {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
</style>
