<template>
  <div class="account-settings">
    <!-- Header bar with gradient -->
    <div class="settings-header">
      <button class="back-btn" @click="goBack">
        <ArrowLeft :size="20" />
      </button>
      <div>
        <h1 class="header-title">Account Settings</h1>
        <p class="header-subtitle">Manage your profile and preferences</p>
      </div>
    </div>

    <div v-if="loading" class="loading">Loading profiles...</div>

    <!-- Content area -->
    <div v-else class="settings-content">
      <!-- Save feedback -->
      <p v-if="saveError" class="save-error">{{ saveError }}</p>
      <p v-if="saveSuccess" class="save-success">Saved</p>

      <!-- Section 1: Profile Information (SharedProfile) -->
      <h2 class="section-title">Shared Profile Information</h2>
      <section class="settings-card">
        <div class="card-header">
          <h3 class="card-title"><User :size="18" /> Profile Information</h3>
        </div>

        <!-- Avatar row: avatar + (name, member since, AID) -->
        <div class="avatar-row">
          <div class="avatar-container">
            <img
              v-if="avatarUrl"
              :src="avatarUrl"
              class="avatar-img"
              alt="Avatar"
            />
            <div v-else class="avatar-placeholder">
              {{ userInitials }}
            </div>
            <input
              ref="avatarFileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleAvatarUpload"
            />
            <button
              class="avatar-camera"
              type="button"
              @click="triggerAvatarFileInput"
              :disabled="uploadingAvatar"
              :title="uploadingAvatar ? 'Uploading...' : 'Change avatar'"
            >
              <Loader2 v-if="uploadingAvatar" :size="14" class="animate-spin" />
              <Camera v-else :size="14" />
            </button>
          </div>
          <div class="avatar-info-column">
            <div class="avatar-info">
              <span class="avatar-name">{{ sharedForm.displayName || 'Member' }}</span>
              <span class="avatar-since">Member since {{ formatDate(memberSinceDate) }}</span>
            </div>
            <!-- AID field (read-only) — aligned with name, compact -->
            <div class="field-group aid-field-group mt-2">
              <label class="field-label">AID (Autonomic Identifier)</label>
              <div class="field-box aid-box">
                <span class="aid-text">{{ aidPrefix || '—' }}</span>
                <button class="copy-btn" @click="copyAid" :title="copied ? 'Copied!' : 'Copy AID'">
                  <Check v-if="copied" :size="14" />
                  <Copy v-else :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Display Name -->
        <div class="field-group">
          <label class="field-label">Display Name</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.displayName"
            placeholder="Your display name"
          />
        </div>

        <!-- Email -->
        <div class="field-group">
          <label class="field-label">Email</label>
          <input
            type="email"
            class="field-input"
            v-model="sharedForm.publicEmail"
            placeholder="Your public email"
          />
          <span class="field-helper">Visible to community members</span>
        </div>
      </section>

      <!-- Section 2: About -->
      <section class="settings-card">
        <div class="card-header">
          <h3 class="card-title"><FileText :size="18" /> About</h3>
        </div>

        <div class="field-group">
          <label class="field-label">Bio</label>
          <textarea
            class="field-input"
            v-model="sharedForm.bio"
            placeholder="Tell us about yourself"
            rows="3"
          ></textarea>
        </div>

        <div class="field-group">
          <label class="field-label">Location</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.location"
            placeholder="Village, City, Country"
          />
        </div>

        <div class="field-group">
          <label class="field-label">Indigenous Community</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.indigenousCommunity"
            placeholder="Your community, people"
          />
        </div>

        <div class="field-group">
          <label class="field-label">Reason for Joining</label>
          <textarea
            class="field-input"
            v-model="sharedForm.joinReason"
            placeholder="Why you joined"
            rows="2"
          ></textarea>
        </div>
      </section>

      <!-- Section 3: Interests & Skills -->
      <section class="settings-card">
        <div class="card-header">
          <h3 class="card-title"><Sparkles :size="18" /> Interests &amp; Skills</h3>
        </div>

        <div class="field-group">
          <label class="field-label">Participation Interests</label>
          <div class="interests-chips">
            <button
              v-for="opt in PARTICIPATION_INTERESTS"
              :key="opt.value"
              type="button"
              class="interest-chip"
              :class="{ 'interest-chip--selected': selectedParticipationValues.has(opt.value) }"
              @click="toggleParticipationInterest(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Additional Interests</label>
          <textarea
            class="field-input"
            v-model="sharedForm.customInterests"
            placeholder="Other interests"
            rows="3"
          ></textarea>
        </div>

        <div class="field-group">
          <label class="field-label">Skills</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.skills"
            placeholder="e.g. Design, Development, Writing"
          />
          <span class="field-helper">Separate with commas</span>
        </div>

        <div class="field-group">
          <label class="field-label">Languages</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.languages"
            placeholder="e.g. English, Te Reo Māori"
          />
          <span class="field-helper">Separate with commas</span>
        </div>
      </section>

      <!-- Section 4: Social & Contact -->
      <section class="settings-card">
        <div class="card-header">
          <h3 class="card-title"><Link2 :size="18" /> Social &amp; Contact</h3>
        </div>

        <div class="field-group">
          <label class="field-label">Public Links</label>
          <input
            type="text"
            class="field-input"
            v-model="sharedForm.publicLinks"
            placeholder="e.g. https://example.com, https://blog.example.com"
          />
          <span class="field-helper">Separate with commas</span>
        </div>

        <div class="field-group">
          <label class="field-label">Social Links</label>
          
          <!-- Existing social links as chips -->
          <div v-if="existingSocialLinks.length > 0" class="social-links-list">
            <div
              v-for="link in existingSocialLinks"
              :key="link.type"
              class="social-link-chip"
            >
              <span class="social-link-label">{{ link.label }}</span>
              <a :href="link.url" target="_blank" rel="noopener noreferrer" class="social-link-url">
                {{ link.url }}
              </a>
              <button
                type="button"
                class="social-link-remove"
                @click="removeSocialLink(link.type)"
                :title="`Remove ${link.label}`"
              >
                <X :size="14" />
              </button>
            </div>
          </div>

          <!-- Add new social link -->
          <div class="social-link-add">
            <select
              v-model="newSocialLinkType"
              class="social-link-select"
              :disabled="availableSocialLinkTypes.length === 0"
              @change="socialLinkError = ''"
            >
              <option value="">Select platform...</option>
              <option
                v-for="option in availableSocialLinkTypes"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <input
              type="url"
              v-model="newSocialLinkUrl"
              class="social-link-input"
              :class="{ 'field-input-error': socialLinkError }"
              placeholder="Enter URL"
              :disabled="!newSocialLinkType"
              @keyup.enter="addSocialLink"
              @input="socialLinkError = ''"
            />
            <button
              type="button"
              class="social-link-add-btn"
              @click="addSocialLink"
              :disabled="!newSocialLinkType || !newSocialLinkUrl || !newSocialLinkUrl.trim()"
            >
              Add
            </button>
          </div>
          <span v-if="socialLinkError" class="field-error">{{ socialLinkError }}</span>
          <span v-else-if="availableSocialLinkTypes.length === 0" class="field-helper">
            All available social links have been added
          </span>
        </div>
      </section>

      <!-- Section 5: Membership (CommunityProfile - read-only) -->
      <!-- <section class="settings-card" v-if="communityProfileData">
        <div class="card-header">
          <h3 class="card-title"><Shield :size="18" /> Membership</h3>
        </div>

        <div class="field-group">
          <label class="field-label">Role</label>
          <div class="field-box">
            <span class="role-badge">{{ communityProfileData.role || '—' }}</span>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Member Since</label>
          <div class="field-box">{{ formatDate(communityProfileData.memberSince as string) }}</div>
        </div>

        <div class="field-group" v-if="asArray(communityProfileData.credentials).length">
          <label class="field-label">Credentials</label>
          <div class="field-box chips-box">
            <span
              v-for="cred in asArray(communityProfileData.credentials)"
              :key="cred"
              class="chip"
            >{{ cred }}</span>
          </div>
        </div>

        <div class="field-group" v-if="asArray(communityProfileData.permissions).length">
          <label class="field-label">Permissions</label>
          <div class="field-box chips-box">
            <span
              v-for="perm in asArray(communityProfileData.permissions)"
              :key="perm"
              class="chip"
            >{{ perm }}</span>
          </div>
        </div>
      </section> -->

      <!-- Section 6: Preferences (PrivateProfile) -->
      <!-- <section class="settings-card">
        <div class="card-header">
          <h3 class="card-title"><Settings :size="18" /> Preferences</h3>
        </div>

        <div class="field-group">
          <label class="field-label">Privacy Settings</label>
          <textarea
            class="field-input"
            v-model="privateForm.privacySettings"
            rows="3"
            placeholder="{}"
          ></textarea>
        </div>

        <div class="field-group">
          <label class="field-label">App Preferences</label>
          <textarea
            class="field-input"
            v-model="privateForm.appPreferences"
            rows="3"
            placeholder="{}"
          ></textarea>
        </div>
      </section> -->

      <!-- Unsaved changes bar -->
      <Transition name="bar">
        <div v-if="hasUnsavedChanges" class="unsaved-bar">
          <span class="unsaved-bar-text">You have unsaved changes</span>
          <div class="unsaved-bar-actions">
            <button type="button" class="btn-discard" @click="discardChanges" :disabled="saving">
              Discard
            </button>
            <button type="button" class="btn-save" @click="saveChanges" :disabled="saving">
              {{ saving ? 'Saving...' : 'Save changes' }}
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import {
  ArrowLeft,
  User,
  FileText,
  Sparkles,
  Link2,
  Shield,
  Settings,
  Copy,
  Check,
  Camera,
  X,
  Loader2,
} from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { useProfilesStore } from 'stores/profiles';
import { useTypesStore } from 'stores/types';
import { useIdentityStore } from 'stores/identity';
import { PARTICIPATION_INTERESTS } from 'stores/onboarding';
import { getFileUrl, uploadFile } from 'src/lib/api/client';

const router = useRouter();
const profilesStore = useProfilesStore();
const typesStore = useTypesStore();
const identityStore = useIdentityStore();

const loading = ref(true);
const saveError = ref('');
const saveSuccess = ref(false);
const copied = ref(false);
const saving = ref(false);
const avatarFileInput = ref<HTMLInputElement | null>(null);
const uploadingAvatar = ref(false);

// Social links state
const newSocialLinkType = ref('');
const newSocialLinkUrl = ref('');
const socialLinkError = ref('');

const SOCIAL_LINK_TYPES = [
  { value: 'facebookUrl', label: 'Facebook' },
  { value: 'linkedinUrl', label: 'LinkedIn' },
  { value: 'twitterUrl', label: 'Twitter / X' },
  { value: 'instagramUrl', label: 'Instagram' },
] as const;

const existingSocialLinks = computed(() => {
  return SOCIAL_LINK_TYPES
    .filter(option => {
      const url = getSocialLinkUrl(option.value);
      return url && url.trim() !== '';
    })
    .map(option => ({
      type: option.value,
      label: option.label,
      url: getSocialLinkUrl(option.value),
    }));
});

const availableSocialLinkTypes = computed(() => {
  return SOCIAL_LINK_TYPES.filter(option => {
    const url = getSocialLinkUrl(option.value);
    return !url || url.trim() === '';
  });
});

function getSocialLinkUrl(type: string): string {
  switch (type) {
    case 'facebookUrl':
      return sharedForm.facebookUrl;
    case 'linkedinUrl':
      return sharedForm.linkedinUrl;
    case 'twitterUrl':
      return sharedForm.twitterUrl;
    case 'instagramUrl':
      return sharedForm.instagramUrl;
    default:
      return '';
  }
}

function setSocialLinkUrl(type: string, url: string) {
  switch (type) {
    case 'facebookUrl':
      sharedForm.facebookUrl = url;
      break;
    case 'linkedinUrl':
      sharedForm.linkedinUrl = url;
      break;
    case 'twitterUrl':
      sharedForm.twitterUrl = url;
      break;
    case 'instagramUrl':
      sharedForm.instagramUrl = url;
      break;
  }
}

function addSocialLink() {
  if (!newSocialLinkType.value || !newSocialLinkUrl.value.trim()) return;
  
  const url = newSocialLinkUrl.value.trim();
  // Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    socialLinkError.value = 'Please enter a valid URL starting with http:// or https://';
    return;
  }
  
  setSocialLinkUrl(newSocialLinkType.value, url);
  newSocialLinkType.value = '';
  newSocialLinkUrl.value = '';
  socialLinkError.value = '';
}

function removeSocialLink(type: string) {
  setSocialLinkUrl(type, '');
}

const aidPrefix = computed(() => identityStore.aidPrefix);

// --- Local form state ---

const sharedForm = reactive({
  displayName: '',
  publicEmail: '',
  bio: '',
  location: '',
  indigenousCommunity: '',
  joinReason: '',
  participationInterests: '',
  customInterests: '',
  skills: '',
  languages: '',
  publicLinks: '',
  facebookUrl: '',
  linkedinUrl: '',
  twitterUrl: '',
  instagramUrl: '',
});

const privateForm = reactive({
  privacySettings: '',
  appPreferences: '',
});

const SHARED_FORM_KEYS = [
  'displayName', 'publicEmail', 'bio', 'location', 'indigenousCommunity', 'joinReason',
  'participationInterests', 'customInterests', 'skills', 'languages', 'publicLinks',
  'facebookUrl', 'linkedinUrl', 'twitterUrl', 'instagramUrl',
] as const;

const PRIVATE_FORM_KEYS = ['privacySettings', 'appPreferences'] as const;

const initialSharedSnapshot = ref<Record<string, string>>({});
const initialPrivateSnapshot = ref<Record<string, string>>({});

function getSharedSnapshot() {
  return SHARED_FORM_KEYS.reduce((acc, k) => {
    acc[k] = sharedForm[k];
    return acc;
  }, {} as Record<string, string>);
}

function getPrivateSnapshot() {
  return PRIVATE_FORM_KEYS.reduce((acc, k) => {
    acc[k] = privateForm[k];
    return acc;
  }, {} as Record<string, string>);
}

const isSharedDirty = computed(() => {
  const init = initialSharedSnapshot.value;
  if (Object.keys(init).length === 0) return false;
  const hasChanges = SHARED_FORM_KEYS.some((k) => {
    const current = String(sharedForm[k] ?? '');
    const initial = String(init[k] ?? '');
    return current !== initial;
  });
  return hasChanges;
});

const isPrivateDirty = computed(() => {
  const init = initialPrivateSnapshot.value;
  if (Object.keys(init).length === 0) return false;
  const hasChanges = PRIVATE_FORM_KEYS.some((k) => {
    const current = String(privateForm[k] ?? '');
    const initial = String(init[k] ?? '');
    return current !== initial;
  });
  return hasChanges;
});

const hasUnsavedChanges = computed(() => isSharedDirty.value || isPrivateDirty.value);

const snapshotKeyCount = computed(() => Object.keys(initialSharedSnapshot.value).length);

// --- Store computeds (read-only) ---

const sharedProfileData = computed(() => {
  const p = profilesStore.getMyProfile('SharedProfile');
  return (p?.data as Record<string, unknown>) || {};
});

const communityProfileData = computed(() => {
  const p = profilesStore.getMyProfile('CommunityProfile');
  return p ? (p.data as Record<string, unknown>) : null;
});

const privateProfileData = computed(() => {
  const p = profilesStore.getMyProfile('PrivateProfile');
  return (p?.data as Record<string, unknown>) || {};
});

const avatarUrl = computed(() => {
  const avatar = sharedProfileData.value.avatar as string;
  return avatar ? getFileUrl(avatar) : null;
});

const userInitials = computed(() => {
  const name = sharedForm.displayName || 'M';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

const memberSinceDate = computed(() => {
  if (communityProfileData.value?.memberSince) {
    return communityProfileData.value.memberSince as string;
  }
  return sharedProfileData.value.createdAt as string || '';
});

// --- Init helpers ---

const arrayFields = ['participationInterests', 'skills', 'languages', 'publicLinks'] as const;

const selectedParticipationValues = computed(() => {
  const raw = sharedForm.participationInterests;
  const arr = raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
  return new Set(arr);
});

function toggleParticipationInterest(value: string) {
  const arr = sharedForm.participationInterests
    ? sharedForm.participationInterests.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  const set = new Set(arr);
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  sharedForm.participationInterests = [...set].join(', ');
}

function initSharedForm() {
  const d = sharedProfileData.value;
  sharedForm.displayName = (d.displayName as string) || '';
  sharedForm.publicEmail = (d.publicEmail as string) || '';
  sharedForm.bio = (d.bio as string) || '';
  sharedForm.location = (d.location as string) || '';
  sharedForm.indigenousCommunity = (d.indigenousCommunity as string) || '';
  sharedForm.joinReason = (d.joinReason as string) || '';
  sharedForm.customInterests = (d.customInterests as string) || '';
  sharedForm.facebookUrl = (d.facebookUrl as string) || '';
  sharedForm.linkedinUrl = (d.linkedinUrl as string) || '';
  sharedForm.twitterUrl = (d.twitterUrl as string) || '';
  sharedForm.instagramUrl = (d.instagramUrl as string) || '';
  // Arrays → comma-separated strings
  for (const field of arrayFields) {
    sharedForm[field] = asArray(d[field]).join(', ');
  }
  // Set snapshot after form is initialized
  initialSharedSnapshot.value = getSharedSnapshot();
}

function initPrivateForm() {
  const d = privateProfileData.value;
  privateForm.privacySettings = formatObject(d.privacySettings);
  privateForm.appPreferences = formatObject(d.appPreferences);
  // Set snapshot after form is initialized
  initialPrivateSnapshot.value = getPrivateSnapshot();
}

// --- Save helpers ---

function buildSharedData(): Record<string, unknown> {
  // Start with existing store data to preserve fields we don't edit (e.g. avatar)
  const data: Record<string, unknown> = { ...sharedProfileData.value };
  // Overlay editable text fields
  data.displayName = sharedForm.displayName;
  data.publicEmail = sharedForm.publicEmail;
  data.bio = sharedForm.bio;
  data.location = sharedForm.location;
  data.indigenousCommunity = sharedForm.indigenousCommunity;
  data.joinReason = sharedForm.joinReason;
  data.customInterests = sharedForm.customInterests;
  data.facebookUrl = sharedForm.facebookUrl;
  data.linkedinUrl = sharedForm.linkedinUrl;
  data.twitterUrl = sharedForm.twitterUrl;
  data.instagramUrl = sharedForm.instagramUrl;
  // Convert comma-separated strings back to arrays
  for (const field of arrayFields) {
    const val = sharedForm[field];
    data[field] = val ? val.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
  }
  return data;
}

function buildPrivateData(): Record<string, unknown> {
  const data: Record<string, unknown> = { ...privateProfileData.value };
  try {
    data.privacySettings = privateForm.privacySettings ? JSON.parse(privateForm.privacySettings) : {};
  } catch { /* keep existing */ }
  try {
    data.appPreferences = privateForm.appPreferences ? JSON.parse(privateForm.appPreferences) : {};
  } catch { /* keep existing */ }
  return data;
}

async function saveSharedProfile() {
  saveError.value = '';
  const data = buildSharedData();
  const existing = profilesStore.getMyProfile('SharedProfile');
  const result = await profilesStore.saveProfile('SharedProfile', data, {
    id: existing?.id,
  });
  if (result.success) {
    saveSuccess.value = true;
    setTimeout(() => { saveSuccess.value = false; }, 2000);
    // Update snapshot to reflect saved state
    initialSharedSnapshot.value = getSharedSnapshot();
  } else {
    saveError.value = result.error || 'Failed to save profile';
  }
}

async function savePrivateProfile() {
  saveError.value = '';
  const data = buildPrivateData();
  const existing = profilesStore.getMyProfile('PrivateProfile');
  const result = await profilesStore.saveProfile('PrivateProfile', data, {
    id: existing?.id,
  });
  if (result.success) {
    saveSuccess.value = true;
    setTimeout(() => { saveSuccess.value = false; }, 2000);
    // Update snapshot to reflect saved state
    initialPrivateSnapshot.value = getPrivateSnapshot();
  } else {
    saveError.value = result.error || 'Failed to save profile';
  }
}

async function saveChanges() {
  try {
    if (isSharedDirty.value) {
      await saveSharedProfile();
    }
    if (isPrivateDirty.value) {
      await savePrivateProfile();
    }
  } catch (error) {
    console.error('Error saving changes:', error);
    saveError.value = 'Failed to save changes. Please try again.';
  }
}

function discardChanges() {
  const s = initialSharedSnapshot.value;
  const p = initialPrivateSnapshot.value;
  // Restore shared form from snapshot
  if (Object.keys(s).length > 0) {
    SHARED_FORM_KEYS.forEach((k) => {
      sharedForm[k] = s[k] ?? '';
    });
  }
  // Restore private form from snapshot
  if (Object.keys(p).length > 0) {
    PRIVATE_FORM_KEYS.forEach((k) => {
      privateForm[k] = p[k] ?? '';
    });
  }
}

function triggerAvatarFileInput() {
  avatarFileInput.value?.click();
}

async function handleAvatarUpload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];

  if (!file) return;

  // Validate file type
  if (!file.type.startsWith('image/')) {
    saveError.value = 'Please select an image file';
    return;
  }

  // Validate file size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    saveError.value = 'Image must be less than 5MB';
    return;
  }

  uploadingAvatar.value = true;
  saveError.value = '';

  try {
    // Upload the file
    const result = await uploadFile(file);
    
    if (result.error || !result.fileRef) {
      saveError.value = result.error || 'Failed to upload avatar';
      return;
    }

    // Update the profile with the new avatar fileRef
    const existing = profilesStore.getMyProfile('SharedProfile');
    const data = { ...sharedProfileData.value, avatar: result.fileRef };
    
    const saveResult = await profilesStore.saveProfile('SharedProfile', data, {
      id: existing?.id,
    });

    if (saveResult.success) {
      saveSuccess.value = true;
      setTimeout(() => { saveSuccess.value = false; }, 2000);
      // Update snapshot to reflect saved state
      initialSharedSnapshot.value = getSharedSnapshot();
    } else {
      saveError.value = saveResult.error || 'Failed to save avatar';
    }
  } catch (error) {
    console.error('Error uploading avatar:', error);
    saveError.value = 'Failed to upload avatar. Please try again.';
  } finally {
    uploadingAvatar.value = false;
    // Reset the input so the same file can be selected again if needed
    if (avatarFileInput.value) {
      avatarFileInput.value.value = '';
    }
  }
}

function goBack() {
  router.push({ name: 'dashboard' });
}

// --- Utilities ---

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function asArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  return [];
}

function formatObject(val: unknown): string {
  if (!val || (typeof val === 'object' && Object.keys(val as object).length === 0)) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val, null, 2);
}

async function copyAid() {
  if (!aidPrefix.value) return;
  try {
    await navigator.clipboard.writeText(aidPrefix.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = aidPrefix.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  }
}

// --- Lifecycle ---

onMounted(async () => {
  if (!typesStore.loaded) {
    await typesStore.loadDefinitions();
  }
  await profilesStore.loadMyProfiles();
  initSharedForm();
  initPrivateForm();
  // Ensure snapshots are set after reactive updates
  await nextTick();
  initialSharedSnapshot.value = getSharedSnapshot();
  initialPrivateSnapshot.value = getPrivateSnapshot();
  loading.value = false;

  const shared = profilesStore.getMyProfile('SharedProfile');
  console.log('[AccountSettings] SharedProfile:', {
    id: shared?.id, data: shared?.data, space: 'community',
  });
  const community = profilesStore.getMyProfile('CommunityProfile');
  console.log('[AccountSettings] CommunityProfile:', {
    id: community?.id, data: community?.data, space: 'community-readonly',
  });
  const priv = profilesStore.getMyProfile('PrivateProfile');
  console.log('[AccountSettings] PrivateProfile:', {
    id: priv?.id, data: priv?.data, space: 'private',
  });
});
</script>

<style scoped>
.account-settings {
  flex: 1;
  background: var(--matou-background, #f4f4f5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.settings-header {
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

.loading {
  text-align: center;
  color: var(--matou-text-secondary, #6b7280);
  padding: 3rem 0;
}

.settings-content {
  width: 720px;
  max-width: 100%;
  margin: 0 auto;
  padding: 1.5rem;
  padding-bottom: 5rem;
}

.unsaved-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1.5rem;
  background: var(--matou-card, white);
  border-top: 1px solid var(--matou-border, #e5e7eb);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
  z-index: 1000;
  max-width: 100vw;
}

.unsaved-bar-text {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground, #6b7280);
}

.unsaved-bar-actions {
  display: flex;
  gap: 0.75rem;
}

.btn-discard {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.5rem;
  border: 1px solid var(--matou-border, #d1e7ea);
  background: var(--matou-card, white);
  color: var(--matou-muted-foreground, #6b7280);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.btn-discard:hover:not(:disabled) {
  background: #f3f4f6;
  color: var(--matou-foreground, #1f2937);
}

.btn-discard:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-save {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.5rem;
  border: none;
  background: var(--matou-primary, #1a4f5e);
  color: white;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.btn-save:hover:not(:disabled) {
  background: #164552;
}

.btn-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.bar-enter-active,
.bar-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.bar-enter-from,
.bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

.section-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
  margin: 0 0 1rem 0;
}

.settings-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.card-header {
  margin-bottom: 1.25rem;
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Avatar row */
.avatar-row {
  display: flex;
  align-items: flex-start;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
}

.avatar-container {
  position: relative;
  width: 130px;
  height: 130px;
  flex-shrink: 0;
}

.avatar-img {
  width: 130px;
  height: 130px;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  width: 130px;
  height: 130px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1a4f5e, #2a7f8f);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 1.5rem;
  font-weight: 600;
}

.avatar-camera {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #1a4f5e;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid white;
  cursor: pointer;
  transition: background-color 0.2s ease, opacity 0.2s ease;
}

.avatar-camera:hover:not(:disabled) {
  background: #2a7f8f;
}

.avatar-camera:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.avatar-info-column {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
}

.avatar-info {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.avatar-name {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
}

.avatar-since {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground, #6b7280);
  white-space: nowrap;
}

/* Field display */
.field-group {
  margin-bottom: 1rem;
}

.field-group:last-child {
  margin-bottom: 0;
}

.field-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-muted-foreground, #6b7280);
  margin-bottom: 0.375rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

/* Read-only field display */
.field-box {
  background: #f0f9fa;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
  word-break: break-word;
  white-space: pre-wrap;
}

/* Editable field input — looks like field-box but interactive */
.field-input {
  background: #f0f9fa;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
  width: 100%;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  box-sizing: border-box;
}

.field-input:hover {
  border-color: #a8d4da;
}

.field-input:focus {
  border-color: #1a4f5e;
  box-shadow: 0 0 0 2px rgba(26, 79, 94, 0.1);
}

.field-input::placeholder {
  color: #9ca3af;
}

textarea.field-input {
  resize: vertical;
  min-height: 60px;
}

.field-helper {
  display: block;
  font-size: 0.7rem;
  color: var(--matou-muted-foreground, #9ca3af);
  margin-top: 0.25rem;
}

.field-error {
  display: block;
  font-size: 0.7rem;
  color: #dc2626;
  margin-top: 0.25rem;
}

.field-input-error {
  border-color: #dc2626 !important;
}

.field-input-error:focus {
  border-color: #dc2626 !important;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.1) !important;
}

/* Participation interests — same look as registration list */
.interests-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.interest-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border-radius: 9999px;
  border: 1px solid var(--matou-border, #d1e7ea);
  background: var(--matou-card, white);
  color: var(--matou-muted-foreground, #6b7280);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.interest-chip:hover {
  border-color: var(--matou-primary, #1a4f5e);
  color: var(--matou-primary, #1a4f5e);
}

.interest-chip--selected {
  background-color: var(--matou-primary, #1a4f5e);
  color: white;
  border-color: var(--matou-primary, #1a4f5e);
  opacity: 0.9;
}

.interest-chip--selected:hover {
  opacity: 1;
}

/* Social links */
.social-links-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.social-link-chip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #f0f9fa;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

.social-link-label {
  font-weight: 500;
  color: var(--matou-foreground, #1f2937);
  min-width: 100px;
}

.social-link-url {
  flex: 1;
  color: var(--matou-primary, #1a4f5e);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.social-link-url:hover {
  text-decoration: underline;
}

.social-link-remove {
  background: none;
  border: none;
  color: var(--matou-muted-foreground, #6b7280);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}

.social-link-remove:hover {
  background: rgba(220, 38, 38, 0.1);
  color: #dc2626;
}

.social-link-add {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.social-link-select {
  flex: 0 0 160px;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  background: var(--matou-card, white);
  color: var(--matou-foreground, #1f2937);
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s ease;
}

.social-link-select:hover:not(:disabled) {
  border-color: #a8d4da;
}

.social-link-select:focus {
  border-color: #1a4f5e;
  box-shadow: 0 0 0 2px rgba(26, 79, 94, 0.1);
}

.social-link-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.social-link-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  background: var(--matou-card, white);
  color: var(--matou-foreground, #1f2937);
  outline: none;
  transition: border-color 0.15s ease;
}

.social-link-input:hover:not(:disabled) {
  border-color: #a8d4da;
}

.social-link-input:focus {
  border-color: #1a4f5e;
  box-shadow: 0 0 0 2px rgba(26, 79, 94, 0.1);
}

.social-link-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.social-link-input.field-input-error {
  border-color: #dc2626;
}

.social-link-input.field-input-error:focus {
  border-color: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.1);
}

.social-link-add-btn {
  flex: 0 0 auto;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.5rem;
  border: none;
  background: var(--matou-primary, #1a4f5e);
  color: white;
  cursor: pointer;
  transition: background 0.15s ease;
}

.social-link-add-btn:hover:not(:disabled) {
  background: #164552;
}

.social-link-add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* AID field — compact, next to avatar column */
.aid-field-group {
  margin-bottom: 0;
}

.aid-field-group .field-label {
  margin-bottom: 0.25rem;
}

.aid-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.7rem;
  max-width: 100%;
}

.aid-text {
  font-family: monospace;
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #1a4f5e;
  padding: 0.25rem;
  border-radius: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease;
}

.copy-btn:hover {
  background: rgba(26, 79, 94, 0.1);
}

/* Chips (read-only sections) */
.chips-box {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.chip {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: #e0f2f1;
  color: #1a4f5e;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 500;
}

/* Role badge */
.role-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: linear-gradient(135deg, #1a4f5e, #2a7f8f);
  color: white;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
}

/* Save feedback */
.save-error {
  color: #ef4444;
  font-size: 0.875rem;
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 0.5rem;
}

.save-success {
  color: #059669;
  font-size: 0.875rem;
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 0.5rem;
}
</style>
