<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="invite-modal" style="min-width: 420px; max-width: 540px;">
      <q-card-section class="modal-header">
        <div class="flex items-center gap-3">
          <div class="icon-box bg-primary/10 p-2 rounded-lg">
            <UserPlus class="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 class="text-lg font-semibold">Invite Member</h3>
            <p class="text-sm text-muted-foreground">Create a pre-configured identity for a new member</p>
          </div>
        </div>
      </q-card-section>

      <q-separator />

      <!-- Form -->
      <q-card-section v-if="!result" class="modal-body">
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1.5">Invitee Name</label>
            <input
              v-model="inviteeName"
              type="text"
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="e.g. Aroha Tamaki"
              :disabled="isSubmitting"
            />
          </div>

          <div>
            <label class="block text-sm font-medium mb-1.5">Role</label>
            <select
              v-model="role"
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              :disabled="isSubmitting"
            >
              <option value="Member">Member</option>
              <option value="Contributor">Contributor</option>
              <option value="Steward">Steward</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium mb-1.5">Email <span class="text-muted-foreground font-normal">(optional)</span></label>
            <input
              v-model="inviteeEmail"
              type="email"
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="e.g. aroha@example.com"
              :disabled="isSubmitting"
            />
            <p class="text-xs text-muted-foreground mt-1">If provided, the invite code will be emailed after creation</p>
          </div>

          <!-- Progress -->
          <div v-if="isSubmitting" class="progress-box bg-primary/5 border border-primary/20 rounded-lg p-3">
            <div class="flex items-center gap-2">
              <Loader2 class="w-4 h-4 text-primary animate-spin shrink-0" />
              <span class="text-sm text-foreground">{{ progress }}</span>
            </div>
          </div>

          <!-- Error -->
          <div v-if="inviteError" class="error-box bg-destructive/10 border border-destructive/30 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <XCircle class="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <span class="text-sm text-destructive">{{ inviteError }}</span>
            </div>
          </div>
        </div>
      </q-card-section>

      <!-- Success Result -->
      <q-card-section v-else class="modal-body">
        <div class="space-y-4">
          <div class="success-box bg-accent/10 border border-accent/20 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <CheckCircle2 class="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <span class="text-sm">Invitation created for <strong>{{ inviteeName }}</strong></span>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium mb-1.5">Invite Code</label>
            <div class="flex gap-2">
              <input
                :value="result.inviteCode"
                type="text"
                readonly
                class="flex-1 px-3 py-2.5 bg-secondary/50 border border-border rounded-lg text-xs font-mono focus:outline-none"
              />
              <button
                class="px-3 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors shrink-0"
                @click="copyLink"
              >
                {{ copied ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <p class="text-xs text-muted-foreground mt-1.5">
              Share this code with {{ inviteeName }}. It can only be used once.
            </p>
          </div>

          <!-- Email invite -->
          <div v-if="inviteeEmail.trim()" class="email-send-box border border-border rounded-lg p-3">
            <div v-if="emailSent" class="flex items-center gap-2">
              <Mail class="w-4 h-4 text-accent shrink-0" />
              <span class="text-sm text-accent">Invite emailed to {{ inviteeEmail }}</span>
            </div>
            <div v-else-if="emailError" class="space-y-2">
              <div class="flex items-start gap-2">
                <XCircle class="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <span class="text-sm text-destructive">{{ emailError }}</span>
              </div>
              <button
                class="w-full px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                @click="handleSendEmail"
              >
                Retry
              </button>
            </div>
            <div v-else>
              <button
                class="w-full px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                :disabled="emailSending"
                @click="handleSendEmail"
              >
                <Loader2 v-if="emailSending" class="w-3.5 h-3.5 animate-spin" />
                <Mail v-else class="w-3.5 h-3.5" />
                <span>{{ emailSending ? 'Sending...' : `Email invite to ${inviteeEmail}` }}</span>
              </button>
            </div>
          </div>

          <div class="aid-info bg-secondary/50 border border-border rounded-lg p-3">
            <div class="text-xs text-muted-foreground mb-1">Invitee AID</div>
            <code class="text-xs font-mono text-foreground/80 break-all">{{ result.inviteeAid }}</code>
          </div>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-actions align="right" class="modal-footer">
        <template v-if="!result">
          <button
            class="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            :disabled="isSubmitting"
            @click="$emit('update:modelValue', false)"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            :disabled="!inviteeName.trim() || isSubmitting"
            @click="handleCreate"
          >
            <span v-if="isSubmitting" class="flex items-center gap-2">
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              Creating...
            </span>
            <span v-else>Create Invitation</span>
          </button>
        </template>
        <template v-else>
          <button
            class="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            @click="handleCreateAnother"
          >
            Invite Another
          </button>
          <button
            class="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            @click="$emit('update:modelValue', false)"
          >
            Done
          </button>
        </template>
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  UserPlus,
  Loader2,
  XCircle,
  CheckCircle2,
  Mail,
} from 'lucide-vue-next';
import { usePreCreatedInvite } from 'src/composables/usePreCreatedInvite';
import { sendInviteEmail } from 'src/lib/api/client';

defineProps<{
  modelValue: boolean;
}>();

defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const { isSubmitting, error: inviteError, progress, result, createInvite, reset } = usePreCreatedInvite();

const inviteeName = ref('');
const role = ref('Member');
const inviteeEmail = ref('');
const copied = ref(false);
const emailSending = ref(false);
const emailSent = ref(false);
const emailError = ref('');

async function handleCreate() {
  if (!inviteeName.value.trim()) return;
  await createInvite({
    inviteeName: inviteeName.value.trim(),
    role: role.value,
  });
}

async function handleSendEmail() {
  if (!result.value || !inviteeEmail.value.trim()) return;

  emailSending.value = true;
  emailError.value = '';

  try {
    const response = await sendInviteEmail({
      email: inviteeEmail.value.trim(),
      inviteCode: result.value.inviteCode,
      inviterName: 'Organisation Admin',
      inviteeName: inviteeName.value.trim(),
    });

    if (response.success) {
      emailSent.value = true;
    } else {
      emailError.value = response.error ?? 'Failed to send email';
    }
  } catch (err) {
    emailError.value = err instanceof Error ? err.message : 'Failed to send email';
  } finally {
    emailSending.value = false;
  }
}

function handleCreateAnother() {
  reset();
  inviteeName.value = '';
  role.value = 'Member';
  inviteeEmail.value = '';
  copied.value = false;
  emailSending.value = false;
  emailSent.value = false;
  emailError.value = '';
}

function copyLink() {
  if (!result.value) return;
  navigator.clipboard.writeText(result.value.inviteCode);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<style lang="scss" scoped>
.invite-modal {
  background-color: var(--matou-card);
  border-radius: 12px;
}

.modal-header {
  padding: 1.25rem 1.5rem;
}

.modal-body {
  padding: 1.25rem 1.5rem;
}

.modal-footer {
  padding: 0.75rem 1.5rem;
}

.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.progress-box {
  background-color: rgba(30, 95, 116, 0.05);
  border-color: rgba(30, 95, 116, 0.2);
}

.error-box {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.success-box {
  background-color: rgba(74, 157, 156, 0.1);
  border-color: rgba(74, 157, 156, 0.2);
}
</style>
