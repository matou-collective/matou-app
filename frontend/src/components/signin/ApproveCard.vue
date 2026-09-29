<template>
  <!-- The approve card and its three follow-on faces (idss spec #1492 stories
       13–16/28, wireframe WS-A2/A2p/A2d/A2r). A CONSENT screen, not a
       code-matching one: everything on the face is what a forgery would fake —
       which service, which site, what is disclosed. No AID, SAID, nonce or
       words on the face; those live only in the details disclosure.

       What is disclosed is drawn as THE CREDENTIAL'S OWN CARD — the card the
       wallet draws for it — with Approve at the foot of that card, so what is
       pressed is visibly the thing being shown (#683; Ben, 2026-09-28). A
       wallet that holds nothing the door asks for never reaches this card: it
       shows the no-credential screen instead (NoCredential.vue).

       The card has TWO FORMS, and the code says which (#688; idss ADR 0282 as
       amended 2026-09-29). `signin` is the card above — carrying the unlock
       line when the code offers a seat unlock and the identity is a steward
       (PU-A2u). `unlock` is the same card with the unlock as its act (PU-A4): a
       locked panel unlocks through the sign-in door, so it asks to unlock, says
       the person is already signed in, shows the same credential, reads Unlock
       at the card's foot, and has NO switch. Its done face is PU-A4d. An
       identity that is not a steward never reaches it (NotASteward.vue). -->
  <div class="approve-card max-w-md mx-auto p-6 space-y-5 text-center">
    <!-- Loading: the wallet is still restoring its session or reading the
         credentials. No actions until the card has its details. -->
    <div
      v-if="phase === 'loading'"
      class="status border border-dashed border-border rounded-md px-3 py-2 text-sm text-left flex items-center gap-2"
      data-status="loading"
      role="status"
      aria-live="polite"
    >
      <span class="spin inline-block w-3 h-3 border-2 border-primary/30 border-t-transparent rounded-full animate-spin"></span>
      {{ unlocking ? 'Getting this unlock ready…' : 'Getting this sign-in ready…' }}
    </div>

    <!-- Unavailable: the card could not be built. The try-again fallback;
         Not now leaves, and the browser page keeps waiting. -->
    <div v-if="phase === 'unavailable'" class="space-y-3">
      <div
        class="status border border-border bg-card rounded-md px-3 py-2 text-sm text-left"
        data-status="unavailable"
        role="alert"
      >
        <b>{{ unlocking ? "Couldn't load this unlock." : "Couldn't load this sign-in." }}</b>
        Your app may still be connecting. Try again.
      </div>
      <div class="space-y-2">
        <MBtn class="w-full" data-action="retry" @click="$emit('retry')">Try again</MBtn>
        <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">Not now</MBtn>
      </div>
    </div>

    <!-- PU-A4's headline: what this does, plainly. Never "sign in to" — the
         person is already signed in, and an unlock must never read as having
         been signed out. Shown with the card only. -->
    <p v-if="view && unlocking && onCard" class="text-lg font-medium" data-field="ask">
      Unlock steward actions on <b data-field="where">this computer</b>?
    </p>
    <!-- Headline: the service first — that is what the person is trying to do. -->
    <p v-else-if="view && !unlocking" class="text-lg font-medium" data-field="ask">
      Sign in to <b data-field="service">{{ view.service }}</b> at
      <b data-field="community">{{ view.community }}</b>?
    </p>

    <!-- The card (WS-A2 `approve-card`; in the unlock form PU-A4 `unlock-card`):
         everything the wireframes draw inside it — the unlock line, the sign-in
         site, what will be shown with its act, the details — is inside this
         element, so a selector written from the wireframe matches what is
         built. It draws nothing itself: the regions keep the layout #683 gave
         them. Kept through Proving (dimmed) and gone once done/refused. -->
    <div
      v-if="view && onCard"
      class="space-y-5"
      :data-field="unlocking ? 'unlock-card' : 'approve-card'"
      :data-service="view.panel ? 'panel' : undefined"
      :data-offer="unlocking ? 'unlock' : undefined"
    >
      <!-- PU-A2u: the steward-unlock line (#663, #688). Present ONLY when the
           code offers a seat unlock and the identity is a steward
           (view.unlockLine), under the headline, on by default. The line IS the
           consent — switching it is the whole gesture, there is no second confirm
           and the passcode never appears. On approve with it on, the wallet
           presents and ARMS in one act, and seals when the landed panel asks; off
           gives an ordinary locked-seat session. The unlock form has no line: it
           has no switch. -->
      <div
        v-if="view.unlockLine && !unlocking"
        class="unlock text-left border border-border rounded-lg p-4 space-y-2 bg-card"
        :class="{ 'opacity-40 pointer-events-none': phase === 'proving' }"
        data-field="unlock-steward-actions-line"
      >
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            class="mt-0.5 shrink-0"
            data-action="toggle-unlock-steward-actions"
            :checked="unlockOn"
            :aria-checked="unlockOn ? 'true' : 'false'"
            @change="$emit('toggle-unlock', ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-sm font-medium">Also unlock steward actions on this computer until you sign out</span>
        </label>
        <p v-if="unlockOn" class="text-xs text-muted-foreground pl-7" data-field="unlock-guard">
          This computer will be able to approve people, issue and revoke credentials, and see who's
          waiting — without typing your twelve words. You can end it from your app at any time.
        </p>
        <p v-else class="text-xs text-muted-foreground pl-7" data-field="unlock-guard" data-status="off">
          You'll be signed in, but this computer won't be able to approve people or issue credentials.
          You can unlock it later from the Members tab.
        </p>
      </div>

      <!-- The sign-in site, and the details disclosure. Kept visible through
           Proving (dimmed) and hidden once done/refused. In the unlock form
           (PU-A4): WHERE first, then the site, then the note that the person is
           already signed in. -->
      <div
        class="card text-left border border-border rounded-lg p-4 space-y-3 bg-card"
        :class="{ 'opacity-40 pointer-events-none': phase === 'proving' }"
      >
        <!-- By name only: the code carries no address for the panel, and none is
             guessed from the sign-in site's. -->
        <div v-if="unlocking" class="kv">
          <div class="text-xs uppercase tracking-wide text-muted-foreground">Where</div>
          <div class="text-sm" data-field="panel-site">{{ view.panelName }}</div>
        </div>

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

        <div v-if="unlocking" class="kv">
          <div class="text-xs uppercase tracking-wide text-muted-foreground">Already signed in</div>
          <div class="text-sm" data-field="session-note">
            You're already signed in on that computer. This only unlocks steward actions.
          </div>
        </div>

        <!-- The details disclosure — for the curious and the auditor, never the
             face (WS-A2). No sealing key is among them: no code carries one. -->
        <details class="det text-xs text-muted-foreground border-t border-dashed border-border pt-2" data-action="details">
          <summary class="cursor-pointer font-semibold">details</summary>
          <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1.5 font-mono break-all">
            <dt class="text-muted-foreground">you</dt>
            <dd data-field="aid">{{ view.details.aid }}</dd>
            <dt class="text-muted-foreground">credential</dt>
            <dd data-field="credential-said">{{ view.details.credentialSaid }}</dd>
            <dt class="text-muted-foreground">{{ unlocking ? 'this unlock' : 'this sign-in' }}</dt>
            <dd data-field="challenge-id">{{ view.details.challengeId }}</dd>
            <dt class="text-muted-foreground">signs over</dt>
            <dd data-field="bound-message">{{ view.details.boundMessage }}</dd>
          </dl>
        </details>
      </div>

      <!-- What will be shown: the credential, as the card the wallet draws for it,
           with Approve at the foot of the card (#683). Kept visible through
           Proving (dimmed, Approve gone) and hidden once done/refused. In the
           unlock form the act reads Unlock and the guard sentence sits above it —
           what that computer will be able to do, for how long, and where to end
           it (PU-A4). -->
      <div
        v-if="view.credential"
        class="shown text-left space-y-2"
        :class="{ 'opacity-40 pointer-events-none': phase === 'proving' }"
        data-field="credential-to-show"
        :data-kind="view.credential.slug || view.credential.kindLabel.toLowerCase()"
      >
        <div class="text-xs uppercase tracking-wide text-muted-foreground">What will be shown</div>
        <WalletCredentialCard v-bind="view.credential.card">
          <template #action="{ painted }">
            <p v-if="unlocking" class="cred-guard" data-field="unlock-guard">
              That computer will be able to approve people, issue and revoke credentials, and see who's
              waiting, until you sign out or the page is closed. You can end it from your app at any time.
            </p>
            <button
              v-if="phase === 'card'"
              type="button"
              class="cred-approve"
              :class="{ 'on-painted': painted }"
              :disabled="!canApprove"
              :data-action="unlocking ? 'approve-unlock' : 'approve'"
              @click="$emit('approve')"
            >
              {{ unlocking ? 'Unlock' : 'Approve' }}
            </button>
          </template>
        </WalletCredentialCard>
      </div>
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
      {{ view?.provingLine }}
    </div>

    <!-- PU-A4d: after Unlock verifies. The door verified the presentation and
         the browser is on its way back to the panel; the wallet is armed and
         answers the panel's request a moment later — so the app must stay open
         for that moment. Never "Unlocked" as a finished fact: the app cannot
         know the panel opened the box, only that it will hand one over. -->
    <div v-if="phase === 'done' && unlocking" class="space-y-4">
      <div
        class="status ok border border-primary/30 bg-primary/10 rounded-md px-3 py-2 text-sm text-left flex flex-col gap-1"
        data-field="unlock-card"
        data-status="done"
        role="status"
      >
        <b data-field="done-title">Unlocking that computer</b>
        <span data-field="done-body">Go back to your browser — Members will open in a moment. Keep this app open until it does.</span>
      </div>
      <MBtn variant="outline" class="w-full" data-action="close" @click="$emit('close')">Close</MBtn>
    </div>

    <!-- WS-A2d: Signed in. The card closes after a beat; on a same-device
         sign-in the browser has already redirected. No claims, timings or AID.

         After a sign-in that ARMED (PU-A2u approved with the line on) the
         handover is still to come — the panel lands, asks, and the wallet seals
         and answers — so the face says what PU-A2u says of it: the app stays
         open until Members appears. It does not close itself. -->
    <div v-else-if="phase === 'done'" class="space-y-4">
      <div
        class="status ok border border-primary/30 bg-primary/10 rounded-md px-3 py-2 text-sm text-left"
        data-status="done"
        role="status"
      >
        <template v-if="armed">
          <b>Signed in.</b>
          <span data-field="done-body"> Go back to your browser, and keep this app open until Members appears.</span>
        </template>
        <template v-else><b>Signed in.</b> Back to your browser.</template>
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

    <!-- The way out (WS-A2). Approve — Unlock, in the unlock form — is at the
         foot of the credential card above; Not now sits beneath the card,
         present only on the card face and only once the card has its service
         details. Not now sends nothing. -->
    <div v-if="phase === 'card' && view" class="space-y-2">
      <MBtn variant="ghost" class="w-full" data-action="not-now" @click="$emit('not-now')">
        Not now
      </MBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MBtn from '../base/MBtn.vue';
import WalletCredentialCard from '../wallet/WalletCredentialCard.vue';
import type { ApproveCardView } from 'src/lib/signin/view';
import type { RefusalCopy } from 'src/lib/signin/refusal';
import type { SigninForm, SigninPhase } from 'src/composables/useSignin';

const props = defineProps<{
  view: ApproveCardView | null;
  phase: SigninPhase;
  refusal: RefusalCopy | null;
  canApprove: boolean;
  /** Whether the steward-unlock line is switched on (default on; only rendered
   *  when `view.unlockLine` is set, #663). */
  unlockOn?: boolean;
  /** The card's form, which the code decides: an ordinary `signin` (the
   *  default), or an `unlock` — a code that says it is one (PU-A4, #688). */
  form?: SigninForm;
  /** Whether the sign-in that just verified armed the wallet to answer the
   *  panel (PU-A2u approved with the line on): its done face says to keep the
   *  app open. An unlock always arms, and has its own done face (PU-A4d). */
  armed?: boolean;
}>();

/** The card is in its unlock form (PU-A4 / PU-A4d). */
const unlocking = computed(() => props.form === 'unlock');
/** The card itself is on screen: its face, or its face dimmed while proving. */
const onCard = computed(() => props.phase === 'card' || props.phase === 'proving');

defineEmits<{
  /** The card's one act: Approve — or, in the unlock form, Unlock. */
  approve: [];
  'not-now': [];
  'try-again': [];
  retry: [];
  close: [];
  /** The steward switched the unlock line (PU-A2u, #663). */
  'toggle-unlock': [on: boolean];
}>();
</script>

<style scoped>
/* Approve, at the foot of the credential card. The card's own button idiom
   (WalletCredentialCard .cred-open — dark, square, uppercase monospace), made
   the full width of the card and a thumb's height: it is the screen's one
   primary act. On a painted card it inverts the card's own pair — the ink (the
   WCAG pick against the card's colour) as its ground, the card's colour as its
   label — so it stands off whatever colour the community chose. */
.cred-approve {
  width: 100%;
  min-height: 44px;
  margin-top: 12px;
  font-family: var(--cred-mono, monospace);
  font-size: 0.875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 10px 13px;
  border: 1px solid var(--matou-foreground, #1f2937);
  border-radius: 6px;
  background: var(--matou-foreground, #1f2937);
  color: var(--matou-background, #ffffff);
  cursor: pointer;
}

.cred-approve:hover:not(:disabled),
.cred-approve:focus-visible {
  filter: brightness(1.2);
}

.cred-approve:focus-visible {
  outline: 2px solid var(--matou-primary);
  outline-offset: 2px;
}

.cred-approve:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cred-approve.on-painted {
  background: var(--cred-paint-ink);
  border-color: var(--cred-paint-ink);
  color: var(--cred-paint-bg);
}

.cred-approve.on-painted:focus-visible {
  outline-color: var(--cred-paint-ink);
}

/* The unlock form's guard sentence, above Unlock at the card's foot. It takes
   the card's own ink, so it reads on a painted card as the card's lines do. */
.cred-guard {
  margin: 12px 0 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--matou-muted-foreground, #6b7280);
}

.shown :deep(.painted) .cred-guard {
  color: currentColor;
  opacity: 0.75;
}

/* On the approve screen the card is one card, not one of a grid of them. */
.shown :deep(.wallet-cred-card) {
  height: auto;
}

.shown :deep(.wallet-cred-card:hover) {
  box-shadow: none;
}
</style>
