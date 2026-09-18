<template>
  <!-- The approve card and its three follow-on faces (idss spec #1492 stories
       13–16/28, wireframe WS-A2/A2p/A2d/A2r). A CONSENT screen, not a
       code-matching one: everything on the face is what a forgery would fake —
       which service, which site, what is disclosed. No AID, SAID, nonce or
       words on the face; those live only in the details disclosure. -->
  <div class="approve-card max-w-md mx-auto p-6 space-y-5 text-center">
    <!-- Headline: the service first — that is what the person is trying to do. -->
    <p v-if="view" class="text-lg font-medium" data-field="ask">
      Sign in to <b data-field="service">{{ view.service }}</b> at
      <b data-field="community">{{ view.community }}</b>?
    </p>

    <!-- The card body: the sign-in site, then what will be shown. Kept visible
         through Proving (dimmed) and hidden once done/refused. -->
    <div
      v-if="view && (phase === 'card' || phase === 'proving')"
      class="card text-left border border-border rounded-lg p-4 space-y-3 bg-card"
      :class="{ 'opacity-40 pointer-events-none': phase === 'proving' }"
      data-field="approve-card"
    >
      <div class="kv">
        <div class="text-xs uppercase tracking-wide text-muted-foreground">Sign-in site</div>
        <div
          class="text-sm"
          data-field="site"
          :data-status="view.isHome ? 'home-site' : 'known-site'"
        >
          {{ view.siteName }} · <span class="font-mono">{{ view.siteAddress }}</span>
          <span
            v-if="view.isHome"
            class="ml-1 inline-block px-1.5 py-0.5 text-xs rounded bg-primary/10 text-primary"
            data-field="home-mark"
          >your community</span>
        </div>
      </div>

      <div class="kv">
        <div class="text-xs uppercase tracking-wide text-muted-foreground">What will be shown</div>
        <div
          v-if="view.credential"
          class="text-sm"
          data-field="credential-to-show"
          :data-kind="view.credential.kindLabel.toLowerCase()"
        >
          Your <b>{{ view.credential.kindLabel }}</b> credential<template v-if="credentialTail"> — {{ credentialTail }}</template>
        </div>
        <div v-else class="text-sm text-muted-foreground" data-field="credential-to-show">
          No matching credential to show.
        </div>
      </div>

      <!-- The details disclosure — for the curious and the auditor, never the
           face (WS-A2). -->
      <details class="det text-xs text-muted-foreground border-t border-dashed border-border pt-2" data-action="details">
        <summary class="cursor-pointer font-semibold">details</summary>
        <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1.5 font-mono break-all">
          <dt class="text-muted-foreground">you</dt>
          <dd data-field="aid">{{ view.details.aid }}</dd>
          <dt class="text-muted-foreground">credential</dt>
          <dd data-field="credential-said">{{ view.details.credentialSaid }}</dd>
          <dt class="text-muted-foreground">this sign-in</dt>
          <dd data-field="challenge-id">{{ view.details.challengeId }}</dd>
          <dt class="text-muted-foreground">signs over</dt>
          <dd data-field="bound-message">{{ view.details.boundMessage }}</dd>
        </dl>
      </details>
    </div>

    <!-- WS-A2p: Proving. One honest line, no percentage or seconds — the copy
         stays true whether the wait is 0.5 s (cached signer) or 5–8 s. -->
    <div
      v-if="phase === 'proving'"
      class="status border border-dashed border-border rounded-md px-3 py-2 text-sm text-left flex items-center gap-2"
      data-status="proving"
      role="status"
      aria-live="polite"
    >
      <span class="spin inline-block w-3 h-3 border-2 border-primary/30 border-t-transparent rounded-full animate-spin"></span>
      Proving you're a member…
    </div>

    <!-- WS-A2d: Signed in. The card closes after a beat; on a same-device
         sign-in the browser has already redirected. No claims, timings or AID. -->
    <div v-if="phase === 'done'" class="space-y-4">
      <div
        class="status ok border border-primary/30 bg-primary/10 rounded-md px-3 py-2 text-sm text-left"
        data-status="done"
        role="status"
      >
        <b>Signed in.</b> Back to your browser.
      </div>
      <MBtn variant="outline" class="w-full" data-action="close" @click="$emit('close')">Close</MBtn>
    </div>

    <!-- WS-A2r: refused. The SAME sentence and tails as the sign-in page. The
         records-unreachable and (wallet-only) site-unreachable cases wear their
         own lines; exactly one refusal shows. -->
    <div v-if="phase === 'refused' && refusal" class="space-y-3">
      <div
        v-if="refusal.kind === 'records-unreachable'"
        class="status border border-border bg-card rounded-md px-3 py-2 text-sm text-left"
        data-status="records-unreachable"
        role="alert"
      >{{ refusal.text }}</div>
      <div
        v-else-if="refusal.kind === 'site-unreachable'"
        class="status border border-border rounded-md px-3 py-2 text-sm text-left"
        data-status="site-unreachable"
        role="alert"
      >{{ refusal.text }}</div>
      <div
        v-else
        class="status bad border border-destructive/30 bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm text-left"
        data-status="refused"
        :data-refusal="refusal.kind"
        role="alert"
      >{{ refusal.text }}</div>

      <div class="space-y-1">
        <MBtn v-if="refusal.showTryAgain" class="w-full" data-action="try-again" @click="$emit('try-again')">
          Try again
        </MBtn>
        <p v-if="refusal.showContact" class="text-xs text-muted-foreground" data-field="contact-line">
          or contact your community's operator
        </p>
      </div>
    </div>

    <!-- The two primary actions (WS-A2). Present only on the card face. -->
    <div v-if="phase === 'card'" class="space-y-2">
      <MBtn class="w-full" :disabled="!canApprove" data-action="approve" @click="$emit('approve')">
        Approve
      </MBtn>
      <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">
        Not now
      </MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MBtn from '../base/MBtn.vue';
import type { ApproveCardView } from 'src/lib/signin/view';
import type { RefusalCopy } from 'src/lib/signin/refusal';
import type { SigninPhase } from 'src/composables/useSignin';

const props = defineProps<{
  view: ApproveCardView | null;
  phase: SigninPhase;
  refusal: RefusalCopy | null;
  canApprove: boolean;
}>();

defineEmits<{
  approve: [];
  'not-now': [];
  'try-again': [];
  close: [];
}>();

/** "Member since 12 Aug 2026" — role + issue date, omitting either when absent. */
const credentialTail = computed(() => {
  const c = props.view?.credential;
  if (!c) return '';
  if (c.role && c.issuedOn) return `${c.role} since ${c.issuedOn}`;
  if (c.role) return c.role;
  if (c.issuedOn) return `Issued ${c.issuedOn}`;
  return '';
});
</script>
