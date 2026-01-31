<template>
  <div class="profile-form-screen h-full flex flex-col bg-background">
    <!-- Loading Overlay -->
    <Transition name="fade">
      <div
        v-if="isCreating"
        class="loading-overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-6 max-w-sm text-center p-8">
          <div class="relative">
            <div class="w-20 h-20 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            <Fingerprint class="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <div>
            <h2 class="text-lg font-semibold mb-2">{{ loadingMessage }}</h2>
            <p class="text-sm text-muted-foreground">{{ loadingSubtext }}</p>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Error Toast -->
    <Transition name="slide-up">
      <div
        v-if="creationError"
        class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-destructive text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 max-w-md"
      >
        <AlertCircle class="w-5 h-5 shrink-0" />
        <div class="flex-1">
          <p class="text-sm font-medium">{{ creationError }}</p>
        </div>
        <button @click="creationError = ''" class="text-white/80 hover:text-white">
          <X class="w-4 h-4" />
        </button>
      </div>
    </Transition>

    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <button
        class="mb-4 text-muted-foreground hover:text-foreground transition-colors"
        @click="onBack"
      >
        <ArrowLeft class="w-5 h-5" />
      </button>
      <h1 class="mb-2">{{ isClaim ? 'Claim Your Profile' : 'Create Your Profile' }}</h1>
      <p class="text-muted-foreground">Tell us about yourself and how you'd like to participate</p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <form class="space-y-6 max-w-2xl mx-auto" @submit.prevent="handleSubmit">
        <!-- Profile Image -->
        <div class="space-y-3 pb-2">
          <label class="text-sm font-medium">Profile Image</label>
          <div class="flex items-center gap-6 min-w-[280px]">
            <div class="relative shrink-0">
              <div
                class="w-20 h-20 max-w-[80px] rounded-full overflow-hidden border-2 border-border bg-secondary flex items-center justify-center"
              >
                <img
                  v-if="avatarPreview"
                  :src="avatarPreview"
                  alt="Profile preview"
                  class="w-full h-full object-cover"
                />
                <User v-else class="w-8 h-8 text-muted-foreground" />
              </div>
              <button
                v-if="avatarPreview"
                type="button"
                class="absolute -top-1 -right-1 w-6 h-6 bg-destructive rounded-full flex items-center justify-center hover:bg-destructive/90 transition-colors"
                @click="removeAvatar"
              >
                <X class="w-4 h-4 text-white" />
              </button>
            </div>
            <div class="flex-1">
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                class="hidden"
                @change="handleFileSelect"
              />
              <MBtn
                type="button"
                variant="outline"
                size="sm"
                @click="triggerFileInput"
              >
                <Upload class="w-4 h-4 mr-2" />
                Upload Image
              </MBtn>
              <p class="text-xs text-muted-foreground mt-2">
                Optional. A unique avatar will be generated from your identity if not provided.
              </p>
            </div>
          </div>
        </div>

        <!-- Name -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="name">Display Name *</label>
          <MInput
            id="name"
            v-model="formData.name"
            type="text"
            placeholder="Your preferred name"
            :error="!!errors.name"
            :errorMessage="errors.name"
          />
          <p class="text-xs text-muted-foreground">
            This is how you'll appear to other community members
          </p>
        </div>

        <!-- Bio -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="bio">Why would you like to join us?</label>
          <textarea
            id="bio"
            v-model="formData.bio"
            rows="3"
            class="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            placeholder="Share your background, interests, and what brings you to Matou..."
          />
          <p class="text-xs text-muted-foreground text-right">
            {{ formData.bio.length }} / 500
          </p>
        </div>

        <!-- Participation Interests -->
        <div class="space-y-3">
          <label class="text-sm font-medium">How would you like to participate?</label>
          <p class="text-xs text-muted-foreground">Select all that interest you</p>
          <div class="space-y-2">
            <label
              v-for="interest in PARTICIPATION_INTERESTS"
              :key="interest.value"
              class="flex items-start gap-3 p-3 border border-border rounded-lg cursor-pointer hover:bg-secondary/50 transition-colors"
              :class="{ 'border-primary bg-primary/5': formData.participationInterests.includes(interest.value) }"
            >
              <input
                type="checkbox"
                :value="interest.value"
                v-model="formData.participationInterests"
                class="col-1 w-4 h-4 rounded border-border text-primary focus:ring-primary/50 shrink-0 mt-5"
              />
              <div class="col">
                <span class="text-sm font-medium">{{ interest.label }}</span>
                <p class="text-xs text-muted-foreground">{{ interest.description }}</p>
              </div>
            </label>
          </div>
        </div>

        <!-- Custom Interests -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="customInterests">
            Tell us in your own words
          </label>
          <p class="text-xs text-muted-foreground">
            Let us know if you have particular interests or ways you'd like to contribute
          </p>
          <textarea
            id="customInterests"
            v-model="formData.customInterests"
            rows="3"
            class="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            placeholder="Share any specific interests, skills, or ways you'd like to contribute..."
          />
          <p class="text-xs text-muted-foreground text-right">
            {{ formData.customInterests.length }} / 300
          </p>
        </div>

        <!-- Terms Agreement -->
        <div class="space-y-3 p-4 bg-secondary/50 border border-border rounded-lg">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="formData.hasAgreedToTerms"
              class="w-4 h-4 rounded border-border text-primary focus:ring-primary/50 shrink-0"
            />
            <div>
              <span class="text-sm">
                I agree to the
                <a href="#" class="text-primary hover:underline" @click.prevent="showTerms">Community Guidelines</a>
                and
                <a href="#" class="text-primary hover:underline" @click.prevent="showPrivacy">Privacy Policy</a>
                *
              </span>
              <p class="text-xs text-muted-foreground mt-1">
                By proceeding, you agree to participate respectfully and protect your recovery phrase.
              </p>
            </div>
          </label>
          <p v-if="errors.terms" class="text-xs text-destructive pl-7">
            {{ errors.terms }}
          </p>
        </div>

        <!-- Submit -->
        <MBtn
          type="submit"
          class="w-full"
          :disabled="!canSubmit"
        >
          Continue
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ArrowLeft, ArrowRight, User, Upload, X, Fingerprint, AlertCircle } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import { useOnboardingStore, PARTICIPATION_INTERESTS, type ParticipationInterest } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { KERIClient } from 'src/lib/keri/client';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const props = withDefaults(defineProps<{
  isClaim?: boolean;
}>(), {
  isClaim: false,
});

const store = useOnboardingStore();
const identityStore = useIdentityStore();

const fileInput = ref<HTMLInputElement | null>(null);
const avatarPreview = ref<string | null>(store.profile.avatarPreview);

// Loading state
const isCreating = ref(false);
const creationError = ref('');
const loadingMessage = ref('');
const loadingSubtext = ref('');

const formData = ref({
  name: store.profile.name,
  bio: store.profile.bio,
  participationInterests: [...store.profile.participationInterests] as ParticipationInterest[],
  customInterests: store.profile.customInterests,
  hasAgreedToTerms: store.profile.hasAgreedToTerms,
});

const errors = ref({
  name: '',
  terms: '',
});

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const canSubmit = computed(() => {
  return (
    formData.value.name.trim().length >= 2 &&
    formData.value.hasAgreedToTerms &&
    formData.value.bio.length <= 500 &&
    formData.value.customInterests.length <= 300
  );
});

// Watch for name changes and clear error
watch(() => formData.value.name, () => {
  errors.value.name = '';
});

watch(() => formData.value.hasAgreedToTerms, () => {
  errors.value.terms = '';
});

function triggerFileInput() {
  fileInput.value?.click();
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];

  if (file) {
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be less than 5MB');
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      avatarPreview.value = e.target?.result as string;
    };
    reader.readAsDataURL(file);

    // Store file in profile
    store.updateProfile({ avatar: file });
  }
}

function removeAvatar() {
  avatarPreview.value = null;
  store.updateProfile({ avatar: null, avatarPreview: null });
  if (fileInput.value) {
    fileInput.value.value = '';
  }
}

function showTerms() {
  // TODO: Open terms modal
  console.log('Show terms');
}

function showPrivacy() {
  // TODO: Open privacy modal
  console.log('Show privacy');
}

async function handleSubmit() {
  // Validate
  errors.value = { name: '', terms: '' };
  creationError.value = '';

  if (formData.value.name.trim().length < 2) {
    errors.value.name = 'Name must be at least 2 characters';
    return;
  }

  if (!formData.value.hasAgreedToTerms) {
    errors.value.terms = 'You must agree to the terms to continue';
    return;
  }

  // Save profile to store first
  store.updateProfile({
    name: formData.value.name.trim(),
    bio: formData.value.bio.trim(),
    avatarPreview: avatarPreview.value,
    participationInterests: formData.value.participationInterests,
    customInterests: formData.value.customInterests.trim(),
    hasAgreedToTerms: formData.value.hasAgreedToTerms,
  });

  // In claim mode, skip identity creation — just save profile and continue
  if (props.isClaim) {
    emit('continue');
    return;
  }

  // Start identity creation
  isCreating.value = true;

  try {
    // Step 1: Generate mnemonic
    loadingMessage.value = 'Generating recovery phrase...';
    loadingSubtext.value = 'Creating your secure 12-word backup';
    await sleep(500); // Brief pause for UX

    const mnemonic = generateMnemonic(wordlist, 128); // 12 words
    const mnemonicWords = mnemonic.split(' ');

    // Step 2: Derive passcode from mnemonic and connect to identity network
    loadingMessage.value = 'Connecting to identity network...';
    loadingSubtext.value = 'Deriving keys from recovery phrase';

    // Derive passcode from mnemonic - this makes the identity recoverable
    const passcode = KERIClient.passcodeFromMnemonic(mnemonic);

    if (!identityStore.isConnected) {
      const connected = await identityStore.connect(passcode);
      if (!connected) {
        throw new Error('Failed to connect to identity network');
      }
    }

    // Step 3: Create AID
    loadingMessage.value = 'Creating your identity...';
    loadingSubtext.value = 'Generating cryptographic keys';

    const aid = await identityStore.createIdentity(formData.value.name.trim(), { useWitnesses: true });

    if (!aid) {
      throw new Error(identityStore.error || 'Failed to create identity');
    }

    // Step 4: Store results
    loadingMessage.value = 'Finalizing...';
    loadingSubtext.value = 'Almost there!';

    store.setMnemonic(mnemonicWords);
    store.setUserAID(aid.prefix);

    await sleep(300); // Brief pause before transition

    // Success - navigate to confirmation
    emit('continue');
  } catch (err) {
    console.error('[ProfileForm] Identity creation failed:', err);
    creationError.value = err instanceof Error ? err.message : 'Failed to create identity. Please try again.';
  } finally {
    isCreating.value = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function onBack() {
  emit('back');
}
</script>

<style lang="scss" scoped>
.profile-form-screen {
  background-color: var(--matou-background);
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

textarea {
  &:focus {
    outline: none;
  }
}

input[type="checkbox"] {
  accent-color: var(--matou-primary);
}

// Loading overlay
.loading-overlay {
  h2 {
    color: var(--matou-foreground);
  }
}

// Transitions
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px);
}
</style>
