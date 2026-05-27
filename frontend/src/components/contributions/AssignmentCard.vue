<template>
  <div class="assignment-card" :class="`state-${state}`">
    <!-- Inline re-offer picker — active after Unassign, takes precedence over
         the state-based panels so the picker stays visible across the
         assigned→confirmed transition. -->
    <div v-if="showInlinePicker" class="inline-picker">
      <div class="label">Offer to a member</div>
      <MemberPicker
        v-model="inlineSelectedId"
        :members="pickerMembers"
        placeholder="Search members..."
        @select="onInlineMemberSelected"
      />
      <div class="row q-mt-sm">
        <q-btn
          no-caps
          flat
          label="Cancel"
          @click="closeInlinePicker"
        />
      </div>
    </div>

    <!-- Unassigned state -->
    <div v-else-if="state === 'unassigned'" class="row-between">
      <div>
        <div class="card-title">No contributor assigned</div>
        <div class="card-sub">Offer this contribution to a member.</div>
      </div>
      <q-btn
        v-if="canOffer"
        no-caps
        unelevated
        color="primary"
        icon="person_add"
        label="Assign"
        @click="showAssignModal = true"
      />
    </div>

    <!-- Offered state -->
    <div v-else-if="state === 'offered'" class="row-between">
      <div>
        <div class="card-title title-with-avatar">
          <UserAvatar :aid="contribution.offered_to" :name="recipientName" :size="20" />
          <span>Offered to {{ recipientName }} — awaiting acceptance</span>
        </div>
        <div v-if="contribution.offered_at" class="card-sub">
          Offered {{ formatDate(contribution.offered_at) }}
        </div>
      </div>
      <q-btn
        v-if="canOffer"
        no-caps
        flat
        color="primary"
        label="Re-offer"
        @click="showAssignModal = true"
      />
    </div>

    <!-- Assigned state -->
    <div v-else-if="state === 'assigned'" class="row-between">
      <div>
        <div class="card-title title-with-avatar">
          <UserAvatar :aid="assignedAid" :name="assignedName" :size="20" />
          <span>Assigned to {{ assignedName }}</span>
        </div>
      </div>
      <q-btn
        v-if="canUnassign"
        no-caps
        outline
        color="negative"
        icon="person_remove"
        label="Unassign"
        :loading="unassigning"
        @click="handleUnassign"
      />
    </div>

    <!-- Terminal-status read-only view -->
    <div v-else-if="state === 'readonly'" class="row-between">
      <div>
        <div class="card-title title-with-avatar">
          <UserAvatar v-if="assignedAid" :aid="assignedAid" :name="assignedName" :size="20" />
          <span>{{ assignedName ? `Was assigned to ${assignedName}` : 'No contributor' }}</span>
        </div>
      </div>
    </div>

    <!-- Modal picker (used by Assign + Re-offer) -->
    <q-dialog v-model="showAssignModal">
      <q-card class="assignment-modal">
        <q-card-section class="row items-center">
          <div class="text-h6">{{ state === 'offered' ? 'Re-offer Contribution' : 'Assign Contribution' }}</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section>
          <MemberPicker
            v-model="modalSelectedId"
            :members="pickerMembers"
            placeholder="Search members..."
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn no-caps flat label="Cancel" v-close-popup />
          <q-btn
            no-caps
            unelevated
            color="primary"
            label="Send Offer"
            :disable="!modalSelectedId"
            :loading="offering"
            @click="submitModalOffer"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useQuasar } from 'quasar';
import { useProfilesStore } from 'stores/profiles';
import { useContributionsStore } from 'stores/contributions';
import MemberPicker, { type MemberOption } from 'src/components/common/MemberPicker.vue';
import UserAvatar from 'src/components/profiles/UserAvatar.vue';
import type { Contribution } from 'src/types/projects';

interface Props {
  contribution: Contribution;
  canOffer: boolean;
  canUnassign: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'offered', updated: Contribution): void;
  (e: 'unassigned', updated: Contribution): void;
}>();

const $q = useQuasar();
const profilesStore = useProfilesStore();
const store = useContributionsStore();

const showAssignModal = ref(false);
const modalSelectedId = ref('');
const showInlinePicker = ref(false);
const inlineSelectedId = ref('');
const offering = ref(false);
const unassigning = ref(false);

const assignedAid = computed(() =>
  props.contribution.assigned_contributor_id ?? props.contribution.assigned_contributor ?? '',
);

const assignedName = computed(() => {
  if (!assignedAid.value) return '';
  const profile = profilesStore.profilesByAid[assignedAid.value];
  return profile?.displayName
    ?? props.contribution.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...';
});

const recipientName = computed(() => {
  const aid = props.contribution.offered_to;
  if (!aid) return '';
  const profile = profilesStore.profilesByAid[aid];
  return profile?.displayName
    ?? props.contribution.offered_to_name
    ?? aid.slice(0, 12) + '...';
});

const TERMINAL_STATUSES = ['changed', 'needs_review', 'incomplete', 'approved', 'signed_off', 'rewarded', 'declined', 'archived'];

const state = computed<'unassigned' | 'offered' | 'assigned' | 'readonly' | 'hidden'>(() => {
  const s = props.contribution.status;
  if (s === 'created') return 'hidden';
  if (TERMINAL_STATUSES.includes(s)) {
    return assignedAid.value || props.contribution.assigned_contributor_name ? 'readonly' : 'hidden';
  }
  if (s === 'offered') return 'offered';
  if (s === 'assigned') return 'assigned';
  return 'unassigned';
});

const pickerMembers = computed<MemberOption[]>(() => {
  // Drop removed/pending members the same way other pickers do.
  // profilesByAid is keyed by AID; the value has no .aid property.
  return Object.entries(profilesStore.profilesByAid)
    .filter(([, p]) => p && p.status !== 'removed' && p.status !== 'pending')
    .map(([aid, p]) => ({ id: aid, name: p.displayName || aid.slice(0, 12) + '...' }));
});

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

async function submitModalOffer() {
  if (!modalSelectedId.value) return;
  const picked = pickerMembers.value.find(m => m.id === modalSelectedId.value);
  offering.value = true;
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: modalSelectedId.value,
      offered_to_name: picked?.name ?? modalSelectedId.value,
    });
    $q.notify({ type: 'positive', message: 'Offer sent.' });
    showAssignModal.value = false;
    modalSelectedId.value = '';
    emit('offered', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    offering.value = false;
  }
}

async function handleUnassign() {
  unassigning.value = true;
  try {
    const updated = await store.unassign(props.contribution.id);
    $q.notify({ type: 'positive', message: 'Contributor unassigned.' });
    showInlinePicker.value = true;
    emit('unassigned', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to unassign' });
  } finally {
    unassigning.value = false;
  }
}

async function onInlineMemberSelected(member: MemberOption) {
  inlineSelectedId.value = member.id;
  offering.value = true;
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: member.id,
      offered_to_name: member.name,
    });
    $q.notify({ type: 'positive', message: 'Offer sent.' });
    showInlinePicker.value = false;
    inlineSelectedId.value = '';
    emit('offered', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    offering.value = false;
  }
}

function closeInlinePicker() {
  showInlinePicker.value = false;
  inlineSelectedId.value = '';
}
</script>

<style scoped lang="scss">
.assignment-card {
  padding: 12px;
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  background: var(--matou-secondary);
  margin: 12px 0;
}

.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  font-weight: 600;
  color: var(--matou-foreground);
}

.card-sub {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.label {
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  color: var(--matou-muted-foreground);
  margin-bottom: 6px;
}

.assignment-modal {
  min-width: 360px;
}

.state-hidden {
  display: none;
}

.title-with-avatar {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
