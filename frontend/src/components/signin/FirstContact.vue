<template>
  <!-- WS-A1: first contact with a sign-in site the wallet has never met (idss
       spec #1492 story 11, #535). Shown BEFORE any approve card: a lookalike
       must not be able to harvest a credential on a reflex. The address is the
       fact and dominant; the code's name is only a claim; there is no Approve
       button here — the member must trust the site before the card appears. -->
  <div class="first-contact max-w-md mx-auto p-6 space-y-5 text-center" data-face="first-contact">
    <p class="text-lg font-medium" data-field="heading">A sign-in site you haven't met</p>

    <!-- The address is the one fact — dominant on the face. -->
    <div class="address text-xl font-mono break-all font-semibold" data-field="address">
      {{ address }}
    </div>

    <!-- The name is a claim, never a fact. -->
    <p class="text-sm text-muted-foreground" data-field="claim">
      It says it is <b>{{ claimedName || address }}</b>.
    </p>

    <!-- One sentence on what trusting discloses. -->
    <p class="text-sm text-muted-foreground" data-field="discloses">
      Trust it only if you meant to sign in here — the next step shows this site
      your membership credential.
    </p>

    <div class="space-y-2">
      <MBtn class="w-full" data-action="trust" @click="$emit('trust')">
        Trust this sign-in site
      </MBtn>
      <MBtn variant="ghost" class="w-full" data-action="dont" @click="$emit('dont')">
        Don't
      </MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import MBtn from '../base/MBtn.vue';

defineProps<{
  /** The sign-in site's address — the fact (e.g. "id.example.nz"). */
  address: string;
  /** The name the code claims for itself; falls back to the address when absent. */
  claimedName: string;
}>();

defineEmits<{
  trust: [];
  dont: [];
}>();
</script>
