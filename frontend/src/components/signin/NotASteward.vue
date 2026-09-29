<template>
  <!-- PU-A4n (#688; idss ADR 0282 as amended 2026-09-29, obligation 2c). The
       code says it is an unlock, and this wallet's identity is NOT one of the
       community's stewards. Being a steward is not a credential — it is
       membership of the community group identity — so holding Administrator
       does not make an unlock possible: there is no seat behind it. The wallet
       says so and SENDS NOTHING: the person is already signed in, so a
       presentation would only repeat the sign-in.

       A screen of its own, the same discipline as the no-credential screen
       (#683): when the wallet already knows the answer, it does not make the
       door say it. Deliberately absent: Unlock / Approve; "ask to become a
       steward" (a promotion is the stewards' act, started from their side);
       the word "refused" — the door was never asked. -->
  <div class="not-a-steward max-w-md mx-auto p-6 space-y-5 text-center" data-face="not-a-steward">
    <div
      class="text-left border border-border rounded-lg p-4 space-y-2 bg-card flex flex-col"
      data-field="unlock-card"
      data-status="not-a-steward"
      role="alert"
    >
      <b class="text-base" data-field="heading">This identity can't unlock steward actions</b>
      <span class="text-sm" data-field="not-a-steward-body">Approving people and issuing credentials are done by your community's stewards, and this identity isn't one of them. You're still signed in to the control panel, and everything else in it works.</span>
      <span class="text-xs text-muted-foreground" data-field="nothing-shown">Nothing was sent.</span>
    </div>

    <MBtn variant="outline" class="w-full" data-action="close" @click="$emit('close')">Close</MBtn>
  </div>
</template>

<script setup lang="ts">
import MBtn from '../base/MBtn.vue';

defineEmits<{
  close: [];
}>();
</script>
