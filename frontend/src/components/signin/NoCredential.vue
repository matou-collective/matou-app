<template>
  <!-- The wallet holds nothing this door asks for (#683; Ben, 2026-09-28: "if the
       user doesnt have the credential they should see a screen saying you do not
       have the required credential to sign into this service"). A screen of its
       own — never the approve card with a disabled button. It names the service
       and the credential it asks for, and says who can issue it. There is no
       Approve: nothing is presented and nothing is posted to the door. The same
       screen answers the door's own `no-credential` refusal. -->
  <div class="no-credential max-w-md mx-auto p-6 space-y-5 text-center" data-face="no-credential">
    <p class="text-lg font-medium" data-field="heading" role="alert">{{ NO_CREDENTIAL_TEXT }}</p>

    <div class="text-left border border-border rounded-lg p-4 space-y-2 bg-card">
      <p class="text-sm" data-field="asked">{{ asked }}</p>
      <p class="text-sm text-muted-foreground" data-field="issuer">{{ issuer }}</p>
    </div>

    <!-- Said only when it is true: the wallet found this out itself, before
         anything left it. -->
    <p v-if="!posted" class="text-xs text-muted-foreground" data-field="nothing-shown">
      Nothing was shown to the sign-in site.
    </p>

    <MBtn variant="outline" class="w-full" data-action="close" @click="$emit('close')">Close</MBtn>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MBtn from '../base/MBtn.vue';
import { NO_CREDENTIAL_TEXT } from 'src/lib/signin/refusal';

const props = defineProps<{
  /** The service that asked, as the code named it ("the control panel", "Files"). */
  service: string;
  /** The community, for who can issue the credential. */
  community: string;
  /** What the door asked for, in words ("Administrator"); blank when unnamed. */
  credentialName: string;
  /** Whether a presentation was posted (the door itself answered no-credential). */
  posted: boolean;
}>();

defineEmits<{
  close: [];
}>();

/** "The control panel asks for the Administrator credential." */
const asked = computed(() => {
  const service = props.service.charAt(0).toUpperCase() + props.service.slice(1);
  return props.credentialName
    ? `${service} asks for the ${props.credentialName} credential.`
    : `${service} asks for a credential this app does not hold.`;
});

/** "A steward of Whakatōhea can issue it to you." */
const issuer = computed(() => `A steward of ${props.community} can issue it to you.`);
</script>
