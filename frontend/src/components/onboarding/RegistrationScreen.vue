<template>
  <div class="registration-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <button
        class="mb-4 text-muted-foreground hover:text-foreground transition-colors"
        @click="onBack"
      >
        <ArrowLeft class="w-5 h-5" />
      </button>
      <h1 class="mb-2">Create Your Profile</h1>
      <p class="text-muted-foreground">Set up your identity in the Matou ecosystem</p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <form class="space-y-6 max-w-md mx-auto" @submit.prevent="handleSubmit">
        <div class="space-y-2">
          <label class="text-sm font-medium" for="name">Name *</label>
          <MInput
            id="name"
            v-model="formData.name"
            type="text"
            placeholder="Your preferred name"
          />
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium" for="email">Email (optional)</label>
          <MInput
            id="email"
            v-model="formData.email"
            type="email"
            placeholder="your@email.com"
          />
          <p class="text-sm text-muted-foreground">
            For recovery and important notifications only
          </p>
        </div>

        <!-- DID Display -->
        <div class="did-card bg-secondary border border-border rounded-xl p-4 md:p-5">
          <div class="flex items-start gap-3">
            <div class="icon-box bg-primary/10 p-2 rounded-lg">
              <Key class="w-5 h-5 text-primary" />
            </div>
            <div class="flex-1 min-w-0">
              <h4 class="mb-1">Your Decentralized Identity</h4>
              <p class="text-sm text-muted-foreground mb-2">
                {{ identityStore.hasIdentity ? 'Your AID (Autonomic Identifier)' : 'Will be generated when you create your profile' }}
              </p>
              <code
                v-if="identityStore.aidPrefix"
                class="text-xs bg-background px-2 py-1 rounded border border-border block overflow-x-auto"
              >
                {{ identityStore.aidPrefix }}
              </code>
              <div
                v-else
                class="text-xs bg-background px-2 py-1 rounded border border-border block text-muted-foreground"
              >
                Pending creation...
              </div>
            </div>
          </div>
        </div>

        <!-- Connection Status -->
        <div
          v-if="connectionStatus"
          class="status-card flex items-center gap-3 p-3 rounded-lg"
          :class="{
            'bg-accent/10 text-accent': connectionStatus === 'connected',
            'bg-yellow-500/10 text-yellow-600': connectionStatus === 'connecting',
            'bg-destructive/10 text-destructive': connectionStatus === 'error'
          }"
        >
          <Loader2 v-if="connectionStatus === 'connecting'" class="w-4 h-4 animate-spin" />
          <CheckCircle2 v-else-if="connectionStatus === 'connected'" class="w-4 h-4" />
          <AlertCircle v-else class="w-4 h-4" />
          <span class="text-sm">{{ connectionMessage }}</span>
        </div>

        <!-- Error Display -->
        <div
          v-if="identityStore.error"
          class="error-card bg-destructive/10 text-destructive p-3 rounded-lg text-sm"
        >
          {{ identityStore.error }}
        </div>

        <!-- Permissions -->
        <div class="space-y-4">
          <h3>Permissions</h3>

          <div
            class="permission-card flex items-start justify-between gap-4 p-4 md:p-5 border border-border rounded-xl"
          >
            <div class="flex items-start gap-3 flex-1">
              <div class="icon-box bg-accent/10 p-2 rounded-lg">
                <Bell class="w-5 h-5 text-accent" />
              </div>
              <div>
                <h4>Notifications</h4>
                <p class="text-sm text-muted-foreground">
                  Governance updates and community messages
                </p>
              </div>
            </div>
            <MToggle v-model="formData.notifications" />
          </div>

          <div
            class="permission-card flex items-start justify-between gap-4 p-4 md:p-5 border border-border rounded-xl"
          >
            <div class="flex items-start gap-3 flex-1">
              <div class="icon-box bg-accent/10 p-2 rounded-lg">
                <Shield class="w-5 h-5 text-accent" />
              </div>
              <div>
                <h4>Secure Backup</h4>
                <p class="text-sm text-muted-foreground">Encrypted credential and key backup</p>
              </div>
            </div>
            <MToggle v-model="formData.secureBackup" />
          </div>
        </div>

        <MBtn type="submit" class="w-full" :loading="isSubmitting" :disabled="!canSubmit">
          {{ submitButtonText }}
        </MBtn>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ArrowLeft, Key, Bell, Shield, Loader2, CheckCircle2, AlertCircle } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import MToggle from '../base/MToggle.vue';
import { useIdentityStore } from 'stores/identity';
import { KERIClient } from 'src/lib/keri/client';

const $q = useQuasar();
const identityStore = useIdentityStore();

const formData = ref({
  name: '',
  email: '',
  notifications: true,
  secureBackup: true,
});

const isSubmitting = ref(false);
const isInitializing = ref(false);

const emit = defineEmits<{
  (e: 'continue', data: { name: string; email: string; aid: string }): void;
  (e: 'back'): void;
}>();

// Connection status
const connectionStatus = computed(() => {
  if (isInitializing.value || identityStore.isConnecting) return 'connecting';
  if (identityStore.isConnected) return 'connected';
  if (identityStore.error) return 'error';
  return null;
});

const connectionMessage = computed(() => {
  if (isInitializing.value || identityStore.isConnecting) return 'Connecting to KERIA...';
  if (identityStore.isConnected) return 'Connected to KERIA';
  if (identityStore.error) return identityStore.error;
  return '';
});

const canSubmit = computed(() => {
  return formData.value.name.trim().length > 0 && identityStore.isConnected;
});

const submitButtonText = computed(() => {
  if (!identityStore.isConnected) return 'Connect to KERIA first';
  return 'Create Profile';
});

onMounted(async () => {
  // Auto-connect to KERIA if not already connected
  if (!identityStore.isConnected) {
    isInitializing.value = true;
    try {
      // Generate a new passcode for this session
      const passcode = KERIClient.generatePasscode();
      const success = await identityStore.connect(passcode);
      if (!success) {
        console.warn('[Registration] Failed to connect to KERIA');
      }
    } catch (err) {
      console.error('[Registration] Error connecting to KERIA:', err);
    } finally {
      isInitializing.value = false;
    }
  }
});

const onBack = () => {
  emit('back');
};

const handleSubmit = async () => {
  if (!formData.value.name.trim()) {
    $q.notify({
      type: 'negative',
      message: 'Please enter your name',
      position: 'top',
    });
    return;
  }

  if (!identityStore.isConnected) {
    $q.notify({
      type: 'negative',
      message: 'Not connected to KERIA. Please wait or refresh.',
      position: 'top',
    });
    return;
  }

  isSubmitting.value = true;

  try {
    // Create AID using Identity Store
    const aid = await identityStore.createIdentity(formData.value.name);

    if (!aid) {
      throw new Error(identityStore.error || 'Failed to create identity');
    }

    $q.notify({
      type: 'positive',
      message: 'Profile created successfully!',
      caption: `AID: ${aid.prefix.slice(0, 12)}...`,
      position: 'top',
    });

    emit('continue', {
      name: formData.value.name,
      email: formData.value.email,
      aid: aid.prefix,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to create profile';
    $q.notify({
      type: 'negative',
      message: errorMessage,
      position: 'top',
    });
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<style lang="scss" scoped>
.registration-screen {
  background-color: var(--matou-background);
}

.did-card {
  background-color: var(--matou-secondary);
}

.permission-card {
  background-color: var(--matou-card);
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

code {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

.status-card {
  font-weight: 500;
}
</style>
