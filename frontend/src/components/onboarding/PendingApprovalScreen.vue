<template>
  <div class="pending-approval-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      :title="statusConfig.title"
      :subtitle="`Kia ora, ${displayUserName}`"
      :show-back-button="false"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8 -mt-6">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Status Card -->
        <div
          v-motion="fadeSlideUp(100)"
          class="status-card bg-card border border-border rounded-2xl p-6 shadow-sm"
        >
          <div class="flex items-start gap-4">
            <div class="icon-box p-3 rounded-xl shrink-0" :class="statusConfig.bgClass">
              <div v-motion="currentStatus === 'reviewing' ? rotate : undefined">
                <component
                  :is="statusConfig.icon"
                  class="w-6 h-6"
                  :class="[statusConfig.iconClass, { 'animate-spin': statusConfig.animate }]"
                />
              </div>
            </div>
            <div class="flex-1">
              <h2 class="mb-2">{{ statusConfig.title }}</h2>
              <p class="text-muted-foreground mb-4">
                {{ statusConfig.description }}
              </p>

              <!-- Error Message -->
              <div v-if="pollingError" class="error-box bg-destructive/10 border border-destructive/20 rounded-xl p-4 mb-4">
                <p class="text-sm text-destructive mb-2">{{ pollingError }}</p>
                <MBtn variant="outline" size="sm" @click="retry">
                  Try Again
                </MBtn>
              </div>

              <!-- Processing Steps (shown when credential is being processed or approved) -->
              <div v-if="currentStatus === 'processing' || currentStatus === 'approved'" class="processing-steps bg-secondary/50 rounded-xl p-4">
                <div class="space-y-3">
                  <div
                    v-for="s in processingSteps"
                    :key="s.key"
                    class="flex items-center gap-3"
                  >
                    <CheckCircle2
                      v-if="isProcessingStepComplete(s.key)"
                      class="w-5 h-5 text-accent shrink-0"
                    />
                    <Loader2
                      v-else-if="isProcessingStepActive(s.key)"
                      class="w-5 h-5 text-primary animate-spin shrink-0"
                    />
                    <Circle
                      v-else
                      class="w-5 h-5 text-muted-foreground/40 shrink-0"
                    />
                    <span
                      class="text-sm"
                      :class="{
                        'text-foreground font-medium': isProcessingStepActive(s.key) || isProcessingStepComplete(s.key),
                        'text-muted-foreground': !isProcessingStepActive(s.key) && !isProcessingStepComplete(s.key),
                      }"
                    >
                      {{ s.label }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Rejection Info (when rejected) -->
        <div
          v-if="currentStatus === 'rejected'"
          v-motion="fadeSlideUp(125)"
          class="rejection-card bg-destructive/5 border border-destructive/20 rounded-2xl p-5"
        >
          <h3 class="font-medium text-destructive mb-2">What you can do</h3>
          <p class="text-sm text-muted-foreground mb-4">
            If you believe this was a mistake or have additional information to share,
            you can contact the community admins for clarification.
          </p>
          <a href="mailto:contact@matou.nz" class="block">
            <MBtn variant="outline" class="w-full">
              Contact Support
            </MBtn>
          </a>
        </div>

        <!-- Your Identity (AID) -->
        <div
          v-if="currentStatus !== 'rejected'"
          class="aid-card bg-card border border-border rounded-xl p-4 shadow-sm"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <span class="text-xs text-muted-foreground">Your Identity Autonomic Identifier (AID)</span>
              <p class="text-sm font-mono truncate">{{ userAID }}</p>
            </div>
            <button
              @click="copyAID"
              class="p-2 rounded-lg hover:bg-secondary transition-colors shrink-0"
              :title="copied ? 'Copied!' : 'Copy AID'"
            >
              <Check v-if="copied" class="w-4 h-4 text-green-600" />
              <Copy v-else class="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        <!-- What Happens Next -->
        <div v-if="currentStatus !== 'rejected'">
          <h3 class="mb-4">What happens next?</h3>
          <div class="space-y-3">
            <!-- Step 1: Book a session -->
            <div
              v-motion="slideInLeft(300)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">1</span>
              </div>
              <div>
                <h4 class="mb-1">Book a Whakawhānaunga Session</h4>
                <p class="text-sm text-muted-foreground">A short call to introduce ourselves and get to know each other</p>
              </div>
            </div>

            <!-- Booking Component -->
            <div
              v-motion="fadeSlideUp(350)"
              class="booking-card bg-card border border-border rounded-xl p-4"
            >
              <!-- Final confirmation message (after email submitted) -->
              <div v-if="bookingConfirmed && selectedSlot" class="booking-confirmed bg-accent/10 border border-accent/20 rounded-xl p-4">
                <div class="flex items-center gap-2 mb-2">
                  <CheckCircle class="w-5 h-5 text-accent" />
                  <span class="font-medium text-foreground">Session requested</span>
                </div>
                <p class="text-sm text-muted-foreground">
                  {{ formatSlotDisplay(selectedSlot) }}
                </p>
                <p class="text-sm text-muted-foreground mt-1">
                  Confirmation will be sent to <span class="font-medium">{{ userEmail }}</span>
                </p>
                <button
                  @click="resetBooking"
                  class="text-sm text-primary hover:underline mt-2"
                >
                  Choose a different time
                </button>
              </div>

              <!-- Email confirmation step (after slot selected) -->
              <div v-else-if="pendingSlot" class="booking-confirm-step">
                <h5 class="text-sm font-medium text-foreground mb-1">Confirm your booking</h5>
                <p class="text-xs text-muted-foreground mb-3">
                  {{ formatSlotDisplay(pendingSlot) }}
                </p>
                <div class="mb-3">
                  <label for="booking-email" class="block text-xs font-medium text-muted-foreground mb-1">
                    Email for confirmation
                  </label>
                  <input
                    id="booking-email"
                    v-model="userEmail"
                    type="email"
                    placeholder="your@email.com"
                    class="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    :disabled="bookingSending"
                  />
                </div>
                <!-- Error message -->
                <p v-if="bookingError" class="text-xs text-destructive mb-2">
                  {{ bookingError }}
                </p>
                <div class="flex gap-2">
                  <button
                    @click="pendingSlot = null"
                    :disabled="bookingSending"
                    class="flex-1 px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    @click="confirmBooking"
                    :disabled="!isValidEmail || bookingSending"
                    class="flex-1 px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Loader2 v-if="bookingSending" class="w-3 h-3 inline animate-spin mr-1" />
                    {{ bookingSending ? 'Sending...' : 'Confirm' }}
                  </button>
                </div>
              </div>

              <!-- Time slot selection -->
              <div v-else>
                <p class="text-xs text-muted-foreground mb-3">
                  Select a time that works for you (shown in {{ userTimezone }}):
                </p>
                <div class="time-slots-grid">
                  <button
                    v-for="slot in availableSlots"
                    :key="slot.id"
                    @click="pendingSlot = slot"
                    class="time-slot-btn"
                  >
                    <span class="slot-day">{{ slot.dayLabel }}</span>
                    <span class="slot-date">{{ slot.dateLabel }}</span>
                    <span class="slot-time">{{ slot.timeLabel }}</span>
                    <span class="slot-nzt">{{ slot.timeNZTLabel }}</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- Step 2: Admin Review -->
            <div
              v-motion="slideInLeft(400)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">2</span>
              </div>
              <div>
                <h4 class="mb-1">Admin Review</h4>
                <p class="text-sm text-muted-foreground">An admin will review your registration details</p>
              </div>
            </div>

            <!-- Step 3: Approval Decision -->
            <div
              v-motion="slideInLeft(500)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">3</span>
              </div>
              <div>
                <h4 class="mb-1">Approval Decision</h4>
                <p class="text-sm text-muted-foreground">You'll receive notification of the decision</p>
              </div>
            </div>

            <!-- Step 4: Welcome to Matou -->
            <div
              v-motion="slideInLeft(600)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">4</span>
              </div>
              <div>
                <h4 class="mb-1">Welcome to Matou</h4>
                <p class="text-sm text-muted-foreground">Full access to governance, contributions, and community chat</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Resources -->
        <div v-if="currentStatus !== 'rejected'" v-motion="fadeSlideUp(700)">
          <h3 class="mb-4">Explore while you wait</h3>
          <p class="text-muted-foreground mb-4">
            Learn more about Matou by browsing our documentation and resources
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            <a
              v-for="(resource, index) in resources"
              :key="index"
              :href="resource.link"
              target="_blank"
              rel="noopener noreferrer"
              v-motion="fadeSlideUp(800 + index * 100)"
              class="resource-card bg-card border border-border rounded-xl p-4 text-left hover:shadow-md transition-all hover:scale-[1.02] group no-underline"
            >
              <div class="flex items-start gap-3">
                <div class="icon-box bg-accent/10 p-2 rounded-lg shrink-0">
                  <component :is="resource.icon" class="w-5 h-5 text-accent" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <h4 class="truncate">{{ resource.title }}</h4>
                    <ExternalLink
                      class="external-link w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    />
                  </div>
                  <p class="text-sm text-muted-foreground">{{ resource.description }}</p>
                </div>
              </div>
            </a>
          </div>
        </div>

        <!-- Help Section -->
        <div
          v-if="currentStatus !== 'rejected'"
          class="help-box bg-secondary/50 border border-border rounded-xl p-5"
        >
          <h4 class="mb-2">Need help?</h4>
          <p class="text-sm text-muted-foreground mb-4">
            If you have questions about your application or the review process, please contact
            our support team.
          </p>
          <a href="mailto:contact@matou.nz" class="block">
            <MBtn variant="outline" class="w-full">Contact Support</MBtn>
          </a>
        </div>
      </div>
    </div>

    <!-- Welcome Overlay -->
    <WelcomeOverlay
      :show="showWelcome"
      :user-name="displayUserName"
      :credential="credential"
      @continue="handleContinue"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Clock, FileText, Target, ExternalLink, CheckCircle, CheckCircle2, Circle, XCircle, Loader2, Copy, Check } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import WelcomeOverlay from './WelcomeOverlay.vue';
import { useAnimationPresets } from 'composables/useAnimationPresets';
import { useCredentialPolling } from 'composables/useCredentialPolling';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { sendBookingEmail } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

const { fadeSlideUp, slideInLeft, rotate } = useAnimationPresets();
const identityStore = useIdentityStore();
const onboardingStore = useOnboardingStore();

// User's AID for display - check both identity store and onboarding store
const userAID = computed(() => {
  return identityStore.currentAID?.prefix 
    ?? onboardingStore.userAID 
    ?? 'Loading...';
});

// Display username with fallback to AID name
const displayUserName = computed(() => {
  // Use prop userName if it's set and not the default 'Member'
  if (props.userName && props.userName !== 'Member') {
    return props.userName;
  }
  // Fallback to AID name
  if (identityStore.currentAID?.name) {
    return identityStore.currentAID.name;
  }
  // Final fallback
  return 'Member';
});

const copied = ref(false);

function copyAID() {
  const aid = identityStore.currentAID?.prefix ?? onboardingStore.userAID;
  if (aid) {
    navigator.clipboard.writeText(aid);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  }
}

interface Props {
  userName: string;
}

const props = withDefaults(defineProps<Props>(), {
  userName: 'Member',
});

const emit = defineEmits<{
  (e: 'approved', credential: any): void;
  (e: 'continue-to-dashboard'): void;
}>();

// Credential polling
const {
  isPolling,
  error: pollingError,
  grantReceived,
  credentialReceived,
  credential,
  spaceInviteReceived,
  spaceInviteKey,
  spaceId,
  readOnlyInviteKey,
  readOnlySpaceId,
  rejectionReceived,
  rejectionInfo,
  startPolling,
  retry,
} = useCredentialPolling({ pollingInterval: 5000 });

// UI State
const showWelcome = ref(false);

// Booking state
interface TimeSlot {
  id: string;
  dateNZT: Date;      // The actual date/time in NZT
  dateLocal: Date;    // Converted to user's local timezone
  dayLabel: string;   // e.g., "Tuesday"
  dateLabel: string;  // e.g., "Feb 11"
  timeLabel: string;  // e.g., "7:00 AM" (in user's local time)
  timeNZTLabel: string; // e.g., "7:00 AM NZT"
}

const selectedSlot = ref<TimeSlot | null>(null);
const pendingSlot = ref<TimeSlot | null>(null);
const userEmail = ref(onboardingStore.profile.email || '');
const bookingConfirmed = ref(false);
const bookingSending = ref(false);
const bookingError = ref<string | null>(null);

// Booking persistence
interface PersistedBooking {
  slotId: string;
  dateNZT: string; // ISO string
  email: string;
  confirmedAt: string;
}

const bookingStorageKey = computed(() => {
  const aid = identityStore.currentAID?.prefix;
  return aid ? `matou_booking_${aid}` : null;
});

async function saveBookingState() {
  if (!bookingStorageKey.value || !selectedSlot.value) return;

  const data: PersistedBooking = {
    slotId: selectedSlot.value.id,
    dateNZT: selectedSlot.value.dateNZT.toISOString(),
    email: userEmail.value,
    confirmedAt: new Date().toISOString(),
  };

  await secureStorage.setItem(bookingStorageKey.value, JSON.stringify(data));
}

async function loadBookingState() {
  if (!bookingStorageKey.value) return;

  try {
    const raw = await secureStorage.getItem(bookingStorageKey.value);
    if (!raw) return;

    const data: PersistedBooking = JSON.parse(raw);
    const bookingDate = new Date(data.dateNZT);

    // Don't restore if the booking is in the past
    if (bookingDate < new Date()) {
      await clearBookingState();
      return;
    }

    // Reconstruct the slot
    const dayLabel = bookingDate.toLocaleDateString('en-US', { weekday: 'long' });
    const dateLabel = bookingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeLabel = bookingDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    // Extract NZT hour from the slot ID (format: YYYYMMDD-HH)
    const hourNZT = parseInt(data.slotId.split('-')[1]);
    const nztHour = hourNZT > 12 ? hourNZT - 12 : hourNZT;
    const nztAmPm = hourNZT >= 12 ? 'PM' : 'AM';
    const timeNZTLabel = `${nztHour}:00 ${nztAmPm} NZT`;

    selectedSlot.value = {
      id: data.slotId,
      dateNZT: bookingDate,
      dateLocal: bookingDate,
      dayLabel,
      dateLabel,
      timeLabel,
      timeNZTLabel,
    };
    userEmail.value = data.email;
    bookingConfirmed.value = true;
  } catch (err) {
    console.warn('[PendingApproval] Failed to load booking state:', err);
  }
}

async function clearBookingState() {
  if (!bookingStorageKey.value) return;
  await secureStorage.removeItem(bookingStorageKey.value);
}

// Email validation
const isValidEmail = computed(() => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(userEmail.value);
});

// Confirm booking and send calendar invite email
async function confirmBooking() {
  if (!pendingSlot.value || !isValidEmail.value) return;

  bookingSending.value = true;
  bookingError.value = null;

  try {
    const slot = pendingSlot.value;
    const result = await sendBookingEmail({
      email: userEmail.value,
      name: onboardingStore.profile.name || 'Member',
      dateTimeUTC: slot.dateNZT.toISOString(),
      dateTimeNZT: `${slot.dateLabel} at ${slot.timeNZTLabel}`,
      dateTimeLocal: formatSlotDisplay(slot),
    });

    if (result.success) {
      selectedSlot.value = slot;
      bookingConfirmed.value = true;
      pendingSlot.value = null;
      await saveBookingState();
    } else {
      bookingError.value = result.error || 'Failed to send confirmation email';
    }
  } catch (err) {
    bookingError.value = 'Failed to send confirmation email. Please try again.';
    console.error('Booking email error:', err);
  } finally {
    bookingSending.value = false;
  }
}

// Reset booking to start over
async function resetBooking() {
  selectedSlot.value = null;
  pendingSlot.value = null;
  bookingConfirmed.value = false;
  userEmail.value = onboardingStore.profile.email || '';
  await clearBookingState();
}

// Get user's timezone for display
const userTimezone = computed(() => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ');
});

// Create a Date representing a specific time in a specific timezone
function createDateInTimezone(year: number, month: number, day: number, hour: number, timezone: string): Date {
  // Start with the desired time as if it were UTC
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));

  // Format this UTC date in the target timezone to find the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcDate);
  const getValue = (type: string) => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value) : 0;
  };

  // Reconstruct what the timezone thinks the date/time is
  const tzYear = getValue('year');
  const tzMonth = getValue('month');
  const tzDay = getValue('day');
  let tzHour = getValue('hour');
  if (tzHour === 24) tzHour = 0; // Handle midnight edge case

  // Calculate offset: the difference between timezone display and our desired time
  const tzAsUTC = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, 0, 0);
  const desiredUTC = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetMs = tzAsUTC - desiredUTC;

  // Subtract the offset to get the UTC time that displays correctly in the timezone
  return new Date(desiredUTC - offsetMs);
}

// Generate available booking slots
// Next 2 Tuesdays and Thursdays, at 7am, 12pm, 7pm NZT, with 3-day minimum lead time
const availableSlots = computed<TimeSlot[]>(() => {
  const slots: TimeSlot[] = [];
  const now = new Date();
  const minBookingDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

  // NZT timezone
  const nztTimezone = 'Pacific/Auckland';

  // Find next Tuesdays and Thursdays in NZT
  // We need to check what day it is in NZT, not local time
  const nztFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: nztTimezone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  const tuesdaysFound: { year: number; month: number; day: number }[] = [];
  const thursdaysFound: { year: number; month: number; day: number }[] = [];

  // Start checking from tomorrow (in NZT)
  let checkDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  while (tuesdaysFound.length < 2 || thursdaysFound.length < 2) {
    const parts = nztFormatter.formatToParts(checkDate);
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const year = parseInt(parts.find(p => p.type === 'year')?.value || '0');
    const month = parseInt(parts.find(p => p.type === 'month')?.value || '0');
    const day = parseInt(parts.find(p => p.type === 'day')?.value || '0');

    if (weekday === 'Tue' && tuesdaysFound.length < 2) {
      tuesdaysFound.push({ year, month, day });
    } else if (weekday === 'Thu' && thursdaysFound.length < 2) {
      thursdaysFound.push({ year, month, day });
    }

    checkDate = new Date(checkDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const foundDates = [...tuesdaysFound, ...thursdaysFound].sort((a, b) => {
    return new Date(a.year, a.month - 1, a.day).getTime() - new Date(b.year, b.month - 1, b.day).getTime();
  });

  // Session times in NZT: 7am, 12pm, 7pm
  const sessionHoursNZT = [7, 12, 19];

  for (const dateInfo of foundDates) {
    for (const hour of sessionHoursNZT) {
      // Create the actual Date object for this NZT time
      const dateUTC = createDateInTimezone(dateInfo.year, dateInfo.month, dateInfo.day, hour, nztTimezone);

      // Skip if before minimum booking date
      if (dateUTC < minBookingDate) continue;

      // Format labels in user's local time
      const dayLabel = dateUTC.toLocaleDateString('en-US', { weekday: 'long' });
      const dateLabel = dateUTC.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const timeLabel = dateUTC.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      // Format NZT time label
      const nztHour = hour > 12 ? hour - 12 : hour;
      const nztAmPm = hour >= 12 ? 'PM' : 'AM';
      const timeNZTLabel = `${nztHour}:00 ${nztAmPm} NZT`;

      slots.push({
        id: `${dateInfo.year}${String(dateInfo.month).padStart(2, '0')}${String(dateInfo.day).padStart(2, '0')}-${hour}`,
        dateNZT: dateUTC,
        dateLocal: dateUTC,
        dayLabel,
        dateLabel,
        timeLabel,
        timeNZTLabel,
      });
    }
  }

  return slots;
});

// Format selected slot for display
function formatSlotDisplay(slot: TimeSlot): string {
  const fullDate = slot.dateLocal.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const time = slot.dateLocal.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${fullDate} at ${time}`;
}

// Computed status for display
const currentStatus = computed(() => {
  if (credentialReceived.value) {
    return 'approved';
  }
  if (rejectionReceived.value) {
    return 'rejected';
  }
  if (grantReceived.value) {
    return 'processing';
  }
  return 'reviewing';
});

const statusConfig = computed(() => {
  switch (currentStatus.value) {
    case 'approved':
      return {
        icon: CheckCircle,
        title: 'Membership approved!',
        description: processingStep.value === 'done'
          ? 'Your community access is ready.'
          : 'Your credential has been issued. Setting up community access...',
        iconClass: 'text-green-600',
        bgClass: 'bg-green-100',
      };
    case 'rejected':
      return {
        icon: XCircle,
        title: 'Registration Declined',
        description: rejectionInfo.value?.reason || 'Your registration has been declined by the community admins.',
        iconClass: 'text-destructive',
        bgClass: 'bg-destructive/10',
      };
    case 'processing':
      return {
        icon: Loader2,
        title: 'Credential detected',
        description: 'Your application has been approved. Processing your membership credential...',
        iconClass: 'text-primary',
        bgClass: 'bg-primary/10',
        animate: true,
      };
    default:
      return {
        icon: Clock,
        title: 'Your application is under review',
        description: 'Thank you for your interest in joining Matou! Our admins have been notified of your registration and will review your application soon.',
        iconClass: 'text-primary',
        bgClass: 'bg-primary/10',
      };
  }
});

// Processing steps for post-approval flow
type ProcessingStep = 'admitting' | 'invite' | 'joining' | 'verifying' | 'done';

const processingStep = ref<ProcessingStep>('admitting');

const processingStepOrder: ProcessingStep[] = ['admitting', 'invite', 'joining', 'verifying', 'done'];

const processingSteps = [
  { key: 'admitting' as ProcessingStep, label: 'Admitting credential' },
  { key: 'invite' as ProcessingStep, label: 'Receiving space invite' },
  { key: 'joining' as ProcessingStep, label: 'Joining community space' },
  { key: 'verifying' as ProcessingStep, label: 'Verifying access' },
  { key: 'done' as ProcessingStep, label: 'Ready to enter' },
];

function isProcessingStepComplete(key: ProcessingStep): boolean {
  const currentIdx = processingStepOrder.indexOf(processingStep.value);
  const stepIdx = processingStepOrder.indexOf(key);
  return currentIdx > stepIdx;
}

function isProcessingStepActive(key: ProcessingStep): boolean {
  return processingStep.value === key;
}

// Start polling and load persisted booking on mount
onMounted(async () => {
  startPolling();
  await loadBookingState();
});

// Guard to prevent concurrent watcher callbacks from racing
let joinInProgress = false;

// Watch for both credential and space invite to be ready
watch(
  [credentialReceived, spaceInviteReceived],
  async ([hasCred, hasInvite]) => {
    if (!hasCred) return;

    if (hasInvite && spaceInviteKey.value && !joinInProgress && processingStep.value !== 'done') {
      // Both received — execute community join with full invite data
      joinInProgress = true;
      processingStep.value = 'joining';

      let joined = await identityStore.joinCommunitySpace({
        inviteKey: spaceInviteKey.value,
        spaceId: spaceId.value ?? undefined,
        readOnlyInviteKey: readOnlyInviteKey.value ?? undefined,
        readOnlySpaceId: readOnlySpaceId.value ?? undefined,
      });

      if (!joined) {
        // Retry a few times
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 3000));
          joined = await identityStore.joinCommunitySpace({
            inviteKey: spaceInviteKey.value!,
            spaceId: spaceId.value ?? undefined,
            readOnlyInviteKey: readOnlyInviteKey.value ?? undefined,
            readOnlySpaceId: readOnlySpaceId.value ?? undefined,
          });
          if (joined) break;
        }
      }

      processingStep.value = 'verifying';
      if (joined) {
        // Refresh spaces in store so dashboard guard passes
        await identityStore.fetchUserSpaces();
      }

      processingStep.value = 'done';
      showWelcome.value = true;
      emit('approved', credential.value);
    } else if (!hasInvite && !joinInProgress && processingStep.value === 'admitting') {
      // Credential just received, invite not yet — advance step indicator
      processingStep.value = 'invite';

      // Check if we already have community access (admin/space-owner case)
      const hasAccess = await identityStore.verifyCommunityAccess();
      if (hasAccess) {
        console.log('[PendingApproval] Already have community access (space owner)');
        joinInProgress = true;
        processingStep.value = 'done';
        showWelcome.value = true;
        emit('approved', credential.value);
      }
      // Otherwise, wait — polling continues and will find the space invite,
      // which triggers this watcher again with [true, true]
    }
  }
);

// Handle continue from welcome overlay
function handleContinue() {
  emit('continue-to-dashboard');
}


const resources = [
  {
    icon: FileText,
    title: 'Documentation',
    description: 'Explore technical documentation and proposal templates',
    link: 'https://docs.matou.nz',
  },
  {
    icon: Target,
    title: 'Contribution Guidelines',
    description: "Discover how to contribute once you're approved",
    link: 'https://docs.matou.nz/operations/contributions/',
  },
];
</script>

<style lang="scss" scoped>
.pending-approval-screen {
  background-color: var(--matou-background);
}

// Header styles are now handled by OnboardingHeader component

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.status-card,
.step-card,
.resource-card {
  background-color: var(--matou-card);
}

.step-number {
  display: flex;
  align-items: center;
  justify-content: center;
}

.help-box {
  background-color: rgba(232, 244, 248, 0.5);
}

.error-box {
  background-color: rgba(var(--matou-destructive-rgb, 220, 38, 38), 0.1);
}

.processing-steps {
  background-color: rgba(232, 244, 248, 0.5);
}

.aid-card {
  background-color: var(--matou-card);
}

.rejection-card {
  background-color: rgba(var(--matou-destructive-rgb, 220, 38, 38), 0.05);
}

.external-link {
  opacity: 0;
  transition: opacity 0.2s ease;
}

.resource-card:hover .external-link {
  opacity: 1;
}

// Booking card
.booking-card {
  background-color: var(--matou-card);
}

.booking-confirmed {
  background-color: rgba(74, 157, 156, 0.1);
}

.time-slots-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;

  @media (min-width: 480px) {
    grid-template-columns: repeat(3, 1fr);
  }

  @media (min-width: 640px) {
    grid-template-columns: repeat(4, 1fr);
  }
}

.time-slot-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.75rem 0.5rem;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  background-color: var(--matou-background);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    border-color: var(--matou-primary);
    background-color: rgba(30, 95, 116, 0.05);
  }

  &:active {
    transform: scale(0.98);
  }
}

.slot-day {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.slot-date {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
}

.slot-time {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-primary);
}

.slot-nzt {
  font-size: 0.625rem;
  color: var(--matou-muted-foreground);
  margin-top: 0.25rem;
}
</style>
