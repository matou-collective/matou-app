<template>
  <div class="setup-screen h-full flex flex-col items-center justify-center p-8 md:p-12">
    <div class="flex flex-col items-center gap-8 max-w-md w-full">
      <!-- Kit logo -->
      <div class="icon-container bg-white/20 backdrop-blur-sm p-6 rounded-2xl">
        <img :src="kitLogo" :alt="t('setup.logoAlt', { brand: KIT.brand.name })" class="w-16 h-16 object-contain" />
      </div>

      <!-- Title -->
      <div class="text-center">
        <h1 class="text-white text-2xl md:text-3xl font-semibold mb-2">{{ t('setup.title', { brand: KIT.brand.name }) }}</h1>
      </div>

      <!-- Info Notice -->
      <div class="info-notice bg-white/10 border border-white/20 rounded-xl p-4 w-full">
        <div class="flex items-start gap-3">
          <Info class="w-5 h-5 text-white/80 flex-shrink-0 mt-0.5" />
          <p class="text-white/80 text-sm">
            {{ t('setup.firstAdminNotice', { brand: KIT.brand.name }) }}
          </p>
        </div>
      </div>

      <!-- Setup Form -->
      <form v-if="!isSubmitting" class="w-full space-y-4" @submit.prevent="handleSubmit">
        <!-- Admin Name -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            {{ t('setup.adminNameLabel') }}
          </label>
          <MInput
            v-model="adminName"
            :placeholder="t('setup.adminNamePlaceholder')"
            :disabled="isSubmitting"
            class="setup-input"
          />
        </div>

        <!-- Admin Email -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            {{ t('setup.adminEmailLabel') }}
            <span class="text-white/50 font-normal">{{ t('common.optional') }}</span>
          </label>
          <MInput
            v-model="adminEmail"
            type="email"
            :placeholder="t('setup.adminEmailPlaceholder')"
            :disabled="isSubmitting"
            class="setup-input"
          />
        </div>

        <!-- Admin Avatar -->
        <div class="form-group">
          <label class="text-white/90 text-sm font-medium mb-2 block">
            {{ t('setup.adminAvatarLabel') }}
            <span class="text-white/50 font-normal">{{ t('common.optional') }}</span>
          </label>
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 rounded-full overflow-hidden border-2 border-white/30 bg-white/10 flex items-center justify-center shrink-0">
              <img
                v-if="avatarPreview"
                :src="avatarPreview"
                :alt="t('setup.avatarPreviewAlt')"
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
                {{ avatarPreview ? t('setup.changeAvatar') : t('setup.uploadAvatar') }}
              </MBtn>
              <MBtn
                v-if="avatarPreview"
                type="button"
                class="ml-2 text-white/60 hover:text-white text-xs"
                @click="removeAvatar"
              >
                {{ t('setup.removeAvatar') }}
            </MBtn>
            </div>
          </div>
        </div>

        <!-- Error Display -->
        <div v-if="error" class="error-banner bg-red-500/20 border border-red-400/30 rounded-xl p-4">
          <div class="flex items-start gap-3">
            <AlertCircle class="w-5 h-5 text-red-300 flex-shrink-0 mt-0.5" />
            <div>
              <p class="text-white font-medium mb-1">{{ t('setup.errorTitle') }}</p>
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
          {{ t('setup.launchApp') }}
        </MBtn>
      </form>

      <!-- Loading State -->
      <div v-else class="w-full text-center space-y-6">
        <div class="loading-spinner">
          <Loader2 class="w-12 h-12 text-white animate-spin mx-auto" />
        </div>
        <div class="space-y-2">
          <p class="text-white text-lg font-medium">{{ t('setup.settingUp') }}</p>
          <p class="text-white/70 text-sm">{{ progress ? t(`setup.progress.${progress}`) : '' }}</p>
        </div>

        <!-- Progress Steps -->
        <div class="progress-steps bg-white/10 rounded-xl p-4 text-left">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('connecting')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('connecting')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('connecting')">{{ t('setup.steps.connecting') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('admin')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('admin')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('admin')">{{ t('setup.steps.admin') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('organization')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('organization')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('organization')">{{ t('setup.steps.organization') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('registry')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('registry')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('registry')">{{ t('setup.steps.registry') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('credential')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('credential')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('credential')">{{ t('setup.steps.credential') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('space')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('space')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('space')">{{ t('setup.steps.space') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="isStepComplete('saving')" class="w-4 h-4 text-green-400" />
              <Loader2 v-else-if="isStepActive('saving')" class="w-4 h-4 text-white animate-spin" />
              <Circle v-else class="w-4 h-4 text-white/40" />
              <span class="text-sm" :class="stepClass('saving')">{{ t('setup.steps.saving') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info, AlertCircle, Rocket, Loader2, CheckCircle2, Circle, User, Upload } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import { useOrgSetup, type OrgSetupStep } from 'src/composables/useOrgSetup';
import { uploadFile } from 'src/lib/api/client';
import { KIT } from 'src/generated/kit';
import kitLogo from 'src/assets/kit/logo.png';

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'setup-complete'): void;
}>();

// Form state
// The organisation is fixed by the kit — the setup screen only collects the
// first admin's profile (coa-kit plan Task 5, issue #241).
const orgName = ref(KIT.brand.name);
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
  return adminName.value.trim().length >= 2;
});

// Progress step helpers. The composable emits a language-independent step key
// (#783); map each to a position in the sequence, and each of the seven
// displayed steps to the position it represents, so the checklist advances
// off the key rather than matching English substrings.
type VisualStep =
  | 'connecting'
  | 'admin'
  | 'organization'
  | 'registry'
  | 'credential'
  | 'space'
  | 'saving';

const STEP_ORDER: Record<Exclude<OrgSetupStep, ''>, number> = {
  generating: 0,
  connecting: 0,
  admin: 1,
  organization: 2,
  registry: 3,
  schema: 3,
  credential: 4,
  oobi: 4,
  backend: 4,
  space: 5,
  saving: 6,
  complete: 7,
};

const VISUAL_ORDER: Record<VisualStep, number> = {
  connecting: 0,
  admin: 1,
  organization: 2,
  registry: 3,
  credential: 4,
  space: 5,
  saving: 6,
};

function currentOrder(): number {
  return progress.value ? STEP_ORDER[progress.value] : -1;
}

function isStepComplete(step: VisualStep): boolean {
  return currentOrder() > VISUAL_ORDER[step];
}

function isStepActive(step: VisualStep): boolean {
  return currentOrder() === VISUAL_ORDER[step];
}

function stepClass(step: VisualStep): string {
  if (isStepComplete(step)) {
    return 'text-green-400';
  }
  if (isStepActive(step)) {
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
  background: var(--matou-brand-gradient);
  min-height: calc(100vh - var(--titlebar-height));
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
  border-radius: 10px !important;

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
