<template>
  <div class="setup-screen h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div class="flex flex-col items-center gap-8 max-w-md w-full">
      <!-- Logo/Icon -->
      <div class="icon-container bg-white/20 backdrop-blur-sm p-6 rounded-2xl">
        <Building2 class="w-16 h-16 text-white" />
      </div>

      <!-- Title -->
      <div class="text-center">
        <h1 class="text-white text-2xl md:text-3xl font-semibold mb-2">Community Setup</h1>
        <p class="text-white/80 text-base">Create your organization to get started</p>
      </div>

      <!-- Info Notice -->
      <div class="info-notice bg-white/10 border border-white/20 rounded-xl p-4 w-full">
        <div class="flex items-start gap-3">
          <Info class="w-5 h-5 text-white/80 flex-shrink-0 mt-0.5" />
          <p class="text-white/80 text-sm">
            No organization found. Create one to start managing identities and credentials.
          </p>
        </div>
      </div>

      <!-- Setup Form -->
      <form v-if="!isSubmitting" class="w-full space-y-4" @submit.prevent="handleSubmit">
        <!-- Organization Name -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            Organization Name
          </label>
          <MInput
            v-model="orgName"
            placeholder="e.g., Matou Community"
            :disabled="isSubmitting"
            class="setup-input"
          />
        </div>

        <!-- Admin Name -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            Admin Display Name
          </label>
          <MInput
            v-model="adminName"
            placeholder="e.g., John Smith"
            :disabled="isSubmitting"
            class="setup-input"
          />
        </div>

        <!-- Admin Email -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            Admin Email
            <span class="text-white/50 font-normal">(optional)</span>
          </label>
          <MInput
            v-model="adminEmail"
            type="email"
            placeholder="admin@example.com"
            :disabled="isSubmitting"
            class="setup-input"
          />
        </div>

        <!-- Admin Avatar -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            Admin Avatar
            <span class="text-white/50 font-normal">(optional)</span>
          </label>
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 rounded-full overflow-hidden border-2 border-white/30 bg-white/10 flex items-center justify-center shrink-0">
              <img
                v-if="avatarPreview"
                :src="avatarPreview"
                alt="Avatar preview"
                class="w-full h-full object-cover"
              />
              <User v-else class="w-6 h-6 text-white/50" />
            </div>
            <div>
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                class="hidden"
                @change="handleFileSelect"
              />
              <MBtn
                type="button"
                size="sm"
                class="text-white bg-white/20 border-white/30 hover:bg-white/30"
                @click="fileInput?.click()"
                :disabled="isSubmitting || isUploadingAvatar"
              >
                <Upload v-if="!isUploadingAvatar" class="w-4 h-4 mr-2" />
                <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
                {{ avatarPreview ? 'Change' : 'Upload' }}
              </MBtn>
              <MBtn
                v-if="avatarPreview"
                type="button"
                class="ml-2 text-white/60 hover:text-white text-xs"
                @click="removeAvatar"
              >
                Remove
            </MBtn>
            </div>
          </div>
        </div>

        <!-- Error Display -->
        <div v-if="error" class="error-banner bg-red-500/20 border border-red-400/30 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <AlertCircle class="w-5 h-5 text-red-300 flex-shrink-0 mt-0.5" />
            <div>
              <p class="text-white font-medium mb-1">Setup Failed</p>
              <p class="text-white/70 text-sm">{{ error }}</p>
            </div>
          </div>
        </div>

        <!-- Submit Button -->
        <MBtn
          type="submit"
          class="w-full submit-btn"
          size="lg"
          :disabled="!isFormValid || isSubmitting || isUploadingAvatar"
        >
          <Rocket class="w-5 h-5 mr-2" />
          Create Organization
        </MBtn>
      </form>

      <!-- Loading State -->
      <div v-else class="w-full text-center space-y-6">
        <div class="loading-spinner">
          <Loader2 class="w-12 h-12 text-white animate-spin mx-auto" />
        </div>
        <div class="space-y-2">
          <p class="text-white text-lg font-medium">Setting up your organization...</p>
          <p class="text-white/70 text-sm">{{ progress }}</p>
        </div>

        <!-- Progress Steps -->
        <div class="progress-steps bg-white/10 rounded-xl p-4 text-left">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('Connecting')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('Connecting')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('Connecting')">Connect to KERIA</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('admin')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('admin')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('admin')">Create admin identity</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('organization')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('organization')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('organization')">Create organization</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('registry')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('registry')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('registry')">Create credential registry</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('credential')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('credential')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('credential')">Issue admin credential</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('space')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('space')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('space')">Create spaces</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('complete')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('Saving')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('Saving')">Save configuration</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Building2, Info, AlertCircle, Rocket, Loader2, CheckCircle2, Circle, User, Upload } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import { useOrgSetup } from 'src/composables/useOrgSetup';
import { uploadFile } from 'src/lib/api/client';

const emit = defineEmits<{
  (e: 'setup-complete'): void;
}>();

// Form state
const orgName = ref('');
const adminName = ref('');
const adminEmail = ref('');
const avatarPreview = ref<string | null>(null);
const avatarFileRef = ref<string | null>(null);
const avatarBase64Data = ref<string | null>(null);
const avatarMimeType = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const isUploadingAvatar = ref(false);

// Setup composable
const { isSubmitting, error, progress, setupOrg } = useOrgSetup();

// Form validation
const isFormValid = computed(() => {
  return orgName.value.trim().length >= 2 && adminName.value.trim().length >= 2;
});

// Progress step helpers
function isStepComplete(keyword: string): boolean {
  if (keyword === 'complete') {
    return progress.value.includes('complete');
  }
  const progressLower = progress.value.toLowerCase();
  const steps = ['connecting', 'admin', 'organization', 'registry', 'credential', 'space', 'saving'];
  const stepIndex = steps.indexOf(keyword.toLowerCase());
  const currentStepIndex = steps.findIndex(s => progressLower.includes(s));
  return stepIndex >= 0 && currentStepIndex >= 0 && stepIndex < currentStepIndex;
}

function isStepActive(keyword: string): boolean {
  return progress.value.toLowerCase().includes(keyword.toLowerCase());
}

function stepClass(keyword: string): string {
  if (isStepComplete(keyword) || isStepComplete('complete')) {
    return 'text-green-400';
  }
  if (isStepActive(keyword)) {
    return 'text-white';
  }
  return 'text-white/40';
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    return; // Max 5MB
  }

  // Show preview and extract base64 data for fallback
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target?.result as string;
    avatarPreview.value = dataUrl;
    // Extract raw base64 from data URL (e.g. "data:image/png;base64,iVBOR...")
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx !== -1) {
      avatarBase64Data.value = dataUrl.substring(commaIdx + 1);
      avatarMimeType.value = file.type || 'image/png';
    }
  };
  reader.readAsDataURL(file);

  // Upload to backend (may fail if community space doesn't exist yet)
  isUploadingAvatar.value = true;
  uploadFile(file)
    .then((result) => {
      if (result.fileRef) {
        avatarFileRef.value = result.fileRef;
        console.log('[OrgSetup] Avatar uploaded, fileRef:', result.fileRef);
      }
    })
    .catch((err) => {
      console.warn('[OrgSetup] Avatar upload failed (will use base64 fallback):', err);
    })
    .finally(() => {
      isUploadingAvatar.value = false;
    });
}

function removeAvatar() {
  avatarPreview.value = null;
  avatarFileRef.value = null;
  avatarBase64Data.value = null;
  avatarMimeType.value = null;
  if (fileInput.value) {
    fileInput.value.value = '';
  }
}

async function handleSubmit() {
  const success = await setupOrg({
    orgName: orgName.value.trim(),
    adminName: adminName.value.trim(),
    adminEmail: adminEmail.value.trim() || undefined,
    adminAvatar: avatarFileRef.value || undefined,
    adminAvatarPreview: avatarPreview.value || undefined,
    adminAvatarData: avatarBase64Data.value || undefined,
    adminAvatarMimeType: avatarMimeType.value || undefined,
  });

  if (success) {
    emit('setup-complete');
  }
}
</script>

<style lang="scss" scoped>
.setup-screen {
  background: linear-gradient(
    135deg,
    var(--matou-primary) 0%,
    rgba(30, 95, 116, 0.9) 50%,
    var(--matou-accent) 100%
  );
  min-height: 100vh;
}

.icon-container {
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
}

.info-notice {
  backdrop-filter: blur(8px);
}

.setup-input {
  :deep(.q-field__control) {
    background-color: rgba(255, 255, 255, 0.15) !important;
    border-color: rgba(255, 255, 255, 0.3) !important;

    &::before {
      border-color: rgba(255, 255, 255, 0.3) !important;
    }

    &:hover::before {
      border-color: rgba(255, 255, 255, 0.5) !important;
    }
  }

  :deep(.q-field--focused .q-field__control) {
    &::before,
    &::after {
      border-color: rgba(255, 255, 255, 0.7) !important;
    }
  }

  :deep(.q-field__native) {
    color: white !important;

    &::placeholder {
      color: rgba(255, 255, 255, 0.5) !important;
    }
  }
}

.submit-btn {
  background-color: #ffffff !important;
  color: var(--matou-primary) !important;
  height: 3.5rem !important;
  border-radius: var(--matou-radius-2xl) !important;

  &:hover:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.9) !important;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.error-banner {
  backdrop-filter: blur(8px);
}

.progress-steps {
  backdrop-filter: blur(8px);
}

.loading-spinner {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}
</style>
