<template>
  <!-- The unlock-only card and its follow-on faces (idss #1929 story 14–16,
       wireframe PU-A4; #664). NOT a sign-in card: the panel session already
       exists (the cookie survived the reload), so there is nothing to sign in to
       and no credential to present. The card carries the unlock and ONLY the
       unlock. Deliberately absent: any "what will be shown" region, any
       suggestion the session is at risk, and a countdown. -->
  <div class="unlock-card max-w-md mx-auto p-6 space-y-5 text-center">
    <!-- Loading: the wallet is still restoring its session. -->
    <div
      v-if="phase === 'loading'"
      class="status border border-dashed border-border rounded-md px-3 py-2 text-sm text-left flex items-center gap-2"
      data-status="loading"
      role="status"
      aria-live="polite"
    >
      <span class="spin inline-block w-3 h-3 border-2 border-primary/30 border-t-transparent rounded-full animate-spin"></span>
      Getting this unlock ready…
    </div>

    <!-- Unavailable: the card could not be built. Try again; Not now leaves. -->
    <div v-if="phase === 'unavailable'" class="space-y-3">
      <div
        class="status border border-border bg-card rounded-md px-3 py-2 text-sm text-left"
        data-status="unavailable"
        role="alert"
      >
        <b>Couldn't load this unlock.</b> Your app may still be connecting. Try again.
      </div>
      <div class="space-y-2">
        <MBtn class="w-full" data-action="retry" @click="$emit('retry')">Try again</MBtn>
        <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">Not now</MBtn>
      </div>
    </div>

    <!-- Expired: the challenge already died before it was scanned. A clean
         refusal — no Unlock, nothing sealed, nothing posted (story 14). -->
    <div v-if="phase === 'expired'" class="space-y-3">
      <div
        class="status border border-border rounded-md px-3 py-2 text-sm text-left"
        data-status="expired"
        role="alert"
      >
        This unlock code has expired. Ask your computer to show a fresh one.
      </div>
      <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">Not now</MBtn>
    </div>

    <!-- Headline: what this does, plainly. -->
    <p v-if="view && (phase === 'card' || phase === 'unlocking')" class="text-lg font-medium" data-field="ask">
      Unlock steward actions on <b data-field="where">this computer</b>?
    </p>

    <!-- The card body: WHERE, then the ALREADY SIGNED IN note, then the guard
         sentence and the details. No "what will be shown" region — nothing is
         presented (PU-A4). -->
    <div
      v-if="view && (phase === 'card' || phase === 'unlocking')"
      class="card text-left border border-border rounded-lg p-4 space-y-3 bg-card"
      :class="{ 'opacity-40 pointer-events-none': phase === 'unlocking' }"
      data-field="unlock-card"
    >
      <div class="kv">
        <div class="text-xs uppercase tracking-wide text-muted-foreground">Where</div>
        <div class="text-sm" data-field="panel-site">
          {{ view.panelName }} · <span class="font-mono">{{ view.panelAddress }}</span>
        </div>
      </div>

      <div class="kv">
        <div class="text-xs uppercase tracking-wide text-muted-foreground">Already signed in</div>
        <div class="text-sm" data-field="session-note">{{ view.signedInNote }}</div>
      </div>

      <p class="text-xs text-muted-foreground" data-field="unlock-guard">
        It will be able to approve people, issue and revoke credentials, and see who's waiting, until
        you sign out. You can end it from your app at any time.
      </p>

      <!-- The details disclosure — for the careful steward, never the face. The
           sealing key is FRESH: it differs from the one at sign-in, by design. -->
      <details class="det text-xs text-muted-foreground border-t border-dashed border-border pt-2" data-action="details">
        <summary class="cursor-pointer font-semibold">details</summary>
        <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1.5 font-mono break-all">
          <dt class="text-muted-foreground">you</dt>
          <dd data-field="aid">{{ view.details.aid }}</dd>
          <dt class="text-muted-foreground">this unlock</dt>
          <dd data-field="challenge-id">{{ view.details.challengeId }}</dd>
          <dt class="text-muted-foreground">sealing key</dt>
          <dd data-field="sealing-key-fingerprint">{{ view.details.sealingKeyFingerprint }} — a fresh key, this computer</dd>
        </dl>
      </details>
    </div>

    <!-- Unlocking: one honest line, no percentage or seconds, no countdown. -->
    <div
      v-if="phase === 'unlocking'"
      class="status border border-dashed border-border rounded-md px-3 py-2 text-sm text-left flex items-center gap-2"
      data-status="unlocking"
      role="status"
      aria-live="polite"
    >
      <span class="spin inline-block w-3 h-3 border-2 border-primary/30 border-t-transparent rounded-full animate-spin"></span>
      Unlocking…
    </div>

    <!-- Done: the seat is unlocked; the panel takes it from here. -->
    <div v-if="phase === 'done'" class="space-y-4">
      <div
        class="status ok border border-primary/30 bg-primary/10 rounded-md px-3 py-2 text-sm text-left"
        data-status="done"
        role="status"
      >
        <b>Unlocked.</b> Back to your computer.
      </div>
      <MBtn variant="outline" class="w-full" data-action="close" @click="$emit('close')">Close</MBtn>
    </div>

    <!-- Refused: a door refusal or an unreachable relay. One line, then Try
         again. No "session at risk" framing (PU-A4). -->
    <div v-if="phase === 'refused' && refusal" class="space-y-3">
      <div
        class="status border border-border rounded-md px-3 py-2 text-sm text-left"
        data-status="refused"
        :data-refusal="refusal.kind"
        role="alert"
      >{{ refusal.text }}</div>
      <div class="space-y-2">
        <MBtn v-if="refusal.showTryAgain" class="w-full" data-action="try-again" @click="$emit('try-again')">
          Try again
        </MBtn>
        <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">Not now</MBtn>
      </div>
    </div>

    <!-- The two primary actions. Present only on the card face. The primary act
         reads Unlock, not Approve — nothing is being approved (PU-A4). -->
    <div v-if="phase === 'card' && view" class="space-y-2">
      <MBtn class="w-full" data-action="approve-unlock" @click="$emit('unlock')">Unlock</MBtn>
      <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">Not now</MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import MBtn from '../base/MBtn.vue';
import type { UnlockCardView } from 'src/lib/signin/view';
import type { RefusalCopy } from 'src/lib/signin/refusal';
import type { UnlockPhase } from 'src/composables/useUnlock';

defineProps<{
  view: UnlockCardView | null;
  phase: UnlockPhase;
  refusal: RefusalCopy | null;
}>();

defineEmits<{
  unlock: [];
  'not-now': [];
  'try-again': [];
  retry: [];
  close: [];
}>();
</script>
