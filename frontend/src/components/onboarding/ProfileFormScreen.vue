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
    <OnboardingHeader
      :title="isClaim ? 'Claim Your Profile' : 'Create Your Profile'"
      subtitle="Tell us about yourself and how you'd like to participate"
      :show-back-button="true"
      @back="onBack"
    />

    <!-- Content -->
    <div ref="contentArea" class="flex-1 overflow-y-auto p-6 md:p-8">
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

        <!-- Email -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="email">Email Address</label>
          <MInput
            id="email"
            v-model="formData.email"
            type="email"
            placeholder="your@email.com"
          />
          <p class="text-xs text-muted-foreground">
            Optional. Used for community contact and notifications.
          </p>
        </div>

        <!-- Bio -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="bio">Tell us a bit about yourself</label>
          <textarea
            id="bio"
            v-model="formData.bio"
            rows="3"
            class="m-textarea w-full px-3 py-2 border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            placeholder="Share a bit about your background, experience, and interests..."
          />
          <p class="text-xs text-muted-foreground text-right">
            {{ formData.bio.length }} / 500
          </p>
        </div>

        <!-- Location -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="location">Location</label>
          <MInput
            id="location"
            v-model="formData.location"
            type="text"
            placeholder="City, Country"
          />
          <p class="text-xs text-muted-foreground">
            Where are you based?
          </p>
        </div>

        <!-- Indigenous Community -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="indigenousCommunity">Indigenous Community</label>
          <MInput
            id="indigenousCommunity"
            v-model="formData.indigenousCommunity"
            type="text"
            placeholder="e.g., Wurundjeri, Noongar, Yolngu..."
          />
          <p class="text-xs text-muted-foreground">
            Optional. Indigenous community that you connect to.
          </p>
        </div>

        <!-- Join Reason -->
        <div class="space-y-2">
          <label class="text-sm font-medium" for="joinReason">Why would you like to join us?</label>
          <textarea
            id="joinReason"
            v-model="formData.joinReason"
            rows="3"
            class="m-textarea w-full px-3 py-2 border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            placeholder="Share what brings you to Matou and what you hope to contribute..."
          />
          <p class="text-xs text-muted-foreground text-right">
            {{ formData.joinReason.length }} / 500
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
            class="m-textarea w-full px-3 py-2 border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            placeholder="Share any specific interests, skills, or ways you'd like to contribute..."
          />
          <p class="text-xs text-muted-foreground text-right">
            {{ formData.customInterests.length }} / 300
          </p>
        </div>

        <!-- Social Links -->
        <div class="space-y-3">
          <label class="text-sm font-medium">Social Links</label>
          <p class="text-xs text-muted-foreground">Optional. Connect with the community on other platforms.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="space-y-1">
              <label class="text-xs text-muted-foreground" for="facebookUrl">Facebook</label>
              <MInput
                id="facebookUrl"
                v-model="formData.facebookUrl"
                type="url"
                placeholder="https://facebook.com/username"
              />
            </div>
            <div class="space-y-1">
              <label class="text-xs text-muted-foreground" for="linkedinUrl">LinkedIn</label>
              <MInput
                id="linkedinUrl"
                v-model="formData.linkedinUrl"
                type="url"
                placeholder="https://linkedin.com/in/username"
              />
            </div>
            <div class="space-y-1">
              <label class="text-xs text-muted-foreground" for="twitterUrl">X (Twitter)</label>
              <MInput
                id="twitterUrl"
                v-model="formData.twitterUrl"
                type="url"
                placeholder="https://x.com/username"
              />
            </div>
            <div class="space-y-1">
              <label class="text-xs text-muted-foreground" for="instagramUrl">Instagram</label>
              <MInput
                id="instagramUrl"
                v-model="formData.instagramUrl"
                type="url"
                placeholder="https://instagram.com/username"
              />
            </div>
          </div>
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
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, ArrowRight, User, Upload, X, Fingerprint, AlertCircle } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useOnboardingStore, PARTICIPATION_INTERESTS, type ParticipationInterest } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { KERIClient } from 'src/lib/keri/client';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { uploadFile } from 'src/lib/api/client';

const props = withDefaults(defineProps<{
  isClaim?: boolean;
}>(), {
  isClaim: false,
});

const router = useRouter();
const store = useOnboardingStore();
const identityStore = useIdentityStore();

const fileInput = ref<HTMLInputElement | null>(null);
const contentArea = ref<HTMLElement | null>(null);
const avatarPreview = ref<string | null>(store.profile.avatarPreview);
const avatarFile = ref<File | null>(null);

// Loading state
const isCreating = ref(false);
const creationError = ref('');
const loadingMessage = ref('');
const loadingSubtext = ref('');

const formData = ref({
  name: store.profile.name,
  email: store.profile.email,
  bio: store.profile.bio,
  location: store.profile.location,
  joinReason: store.profile.joinReason,
  indigenousCommunity: store.profile.indigenousCommunity,
  facebookUrl: store.profile.facebookUrl,
  linkedinUrl: store.profile.linkedinUrl,
  twitterUrl: store.profile.twitterUrl,
  instagramUrl: store.profile.instagramUrl,
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
    formData.value.joinReason.length <= 500 &&
    formData.value.customInterests.length <= 300 &&
    formData.value.indigenousCommunity.length <= 200
  );
});

// Scroll to top when component mounts
onMounted(() => {
  // Use setTimeout to ensure DOM is fully rendered
  setTimeout(() => {
    // Scroll the component's content area
    if (contentArea.value) {
      contentArea.value.scrollTop = 0;
    }
    // Scroll page container
    const pageContainer = document.querySelector('.q-page-container');
    if (pageContainer) {
      pageContainer.scrollTop = 0;
    }
    // Scroll onboarding page
    const onboardingPage = document.querySelector('.onboarding-page');
    if (onboardingPage) {
      onboardingPage.scrollTop = 0;
    }
    // Scroll window as fallback
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, 100);
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
    // Validate file size (max 2MB for inclusion in message)
    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be less than 2MB');
      return;
    }

    // Create preview and store base64 data
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      avatarPreview.value = dataUrl;

      // Extract base64 data (remove "data:image/...;base64," prefix)
      const base64Data = dataUrl.split(',')[1];
      store.updateProfile({
        avatar: file,
        avatarData: base64Data,
        avatarMimeType: file.type,
      });
      console.log('[ProfileForm] Avatar stored as base64, size:', base64Data.length, 'mime:', file.type);
    };
    reader.readAsDataURL(file);

    // Store file for upload
    avatarFile.value = file;
  }
}

function removeAvatar() {
  avatarPreview.value = null;
  avatarFile.value = null;
  store.updateProfile({
    avatar: null,
    avatarPreview: null,
    avatarFileRef: null,
    avatarData: null,
    avatarMimeType: null,
  });
  if (fileInput.value) {
    fileInput.value.value = '';
  }
}

function saveFormToStore() {
  store.updateProfile({
    name: formData.value.name.trim(),
    email: formData.value.email.trim(),
    bio: formData.value.bio.trim(),
    location: formData.value.location.trim(),
    joinReason: formData.value.joinReason.trim(),
    indigenousCommunity: formData.value.indigenousCommunity.trim(),
    facebookUrl: formData.value.facebookUrl.trim(),
    linkedinUrl: formData.value.linkedinUrl.trim(),
    twitterUrl: formData.value.twitterUrl.trim(),
    instagramUrl: formData.value.instagramUrl.trim(),
    avatarPreview: avatarPreview.value,
    participationInterests: formData.value.participationInterests,
    customInterests: formData.value.customInterests.trim(),
    hasAgreedToTerms: formData.value.hasAgreedToTerms,
  });
}

function showTerms() {
  saveFormToStore();
  router.push('/community-guidelines');
}

function showPrivacy() {
  saveFormToStore();
  router.push('/privacy-policy');
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
  saveFormToStore();

  // Upload avatar if selected
  console.log('[ProfileForm] Avatar file selected:', !!avatarFile.value);
  if (avatarFile.value) {
    try {
      console.log('[ProfileForm] Uploading avatar...');
      const result = await uploadFile(avatarFile.value);
      if (result.fileRef) {
        store.updateProfile({ avatarFileRef: result.fileRef });
        console.log('[ProfileForm] Avatar uploaded, fileRef:', result.fileRef);
      } else {
        console.warn('[ProfileForm] Avatar upload failed:', result.error);
      }
    } catch (err) {
      console.warn('[ProfileForm] Avatar upload error:', err);
    }
  } else {
    console.log('[ProfileForm] No avatar file to upload');
  }

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

// h1 styles are now handled in the header-gradient section

textarea {
  &:focus {
    outline: none;
  }
}

.m-textarea {
  background-color: var(--matou-input-background);
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
