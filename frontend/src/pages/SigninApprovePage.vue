<template>
  <div class="signin-approve-page h-full flex flex-col bg-background">
    <div class="flex-1 overflow-y-auto py-8">
      <!-- WS-A1: an unmet sign-in site stops here before any card (#535). -->
      <FirstContact
        v-if="signin.phase.value === 'first-contact' && signin.view.value"
        :address="signin.view.value.siteAddress"
        :claimed-name="signin.ask.value?.community ?? ''"
        :credential-name="shownKomitiName"
        @trust="signin.trust"
        @dont="onDont"
      />
      <!-- The wallet holds nothing this door asks for (#683): a screen of its
           own, with no Approve. -->
      <NoCredential
        v-else-if="signin.phase.value === 'no-credential' && signin.view.value"
        :service="signin.view.value.service"
        :community="signin.view.value.community"
        :credential-name="signin.view.value.askedName"
        :posted="signin.posted.value"
        @close="onClose"
      />
      <!-- A code that says it is an unlock, opened by an identity that is not a
           steward (PU-A4n, #688): said by the app, and nothing is sent. -->
      <NotASteward v-else-if="signin.phase.value === 'not-a-steward'" @close="onClose" />
      <!-- The approve card — in its unlock form when the code says it is an
           unlock (PU-A4, #688). -->
      <ApproveCard
        v-else
        :view="signin.view.value"
        :phase="signin.phase.value"
        :refusal="signin.refusal.value"
        :can-approve="canApprove"
        :unlock-on="signin.unlockOn.value"
        :form="signin.form.value"
        :armed="signin.armed.value"
        @approve="signin.approve"
        @not-now="onNotNow"
        @try-again="signin.tryAgain"
        @retry="signin.retry"
        @toggle-unlock="signin.setUnlock"
        @close="onClose"
      />
      <p v-if="notALink" class="text-center text-sm text-muted-foreground mt-6">
        That doesn't look like a sign-in code.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ApproveCard from 'src/components/signin/ApproveCard.vue';
import FirstContact from 'src/components/signin/FirstContact.vue';
import NoCredential from 'src/components/signin/NoCredential.vue';
import NotASteward from 'src/components/signin/NotASteward.vue';
import { useSignin } from 'src/composables/useSignin';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { signinAskFromQuery, type SigninAsk } from 'src/lib/signin/link';

const route = useRoute();
const router = useRouter();
const signin = useSignin();
const knownDoors = useKnownDoorsStore();

const notALink = ref(false);
const canApprove = computed(() => !!signin.view.value && !!signin.chosen.value?.sad?.d);
/** The name of the komiti credential about to be shown (e.g. "Administrator"),
 *  for the first-contact disclosure; blank when it is a Membership (#683). */
const shownKomitiName = computed(() => {
  const shown = signin.view.value?.credential;
  return shown?.slug ? shown.name : '';
});

/**
 * Close the card after a beat once the door answers VERIFIED (WS-A2d). Not
 * after an unlock (PU-A4d) or a sign-in that armed (PU-A2u, the line on): that
 * face carries the one instruction that matters — keep this app open until
 * Members appears — so it stays until it is closed.
 */
watch(signin.phase, (p) => {
  if (p === 'done' && !signin.keepOpen.value) setTimeout(onClose, 1500);
});

/**
 * A fresh sign-in code that arrives while the card is already mounted routes
 * here again with a new `c=` (a re-scan, a new deep link, or the member opening
 * a freshly-minted `matou://signin?c=…`). Vue reuses this component for the
 * same route, so `onMounted` does not fire again — without this the wallet would
 * keep presenting the FIRST challenge it saw. Rebuild the card from the new ask
 * so the newest challenge always wins (#675).
 */
watch(
  () => route.query.c,
  (c) => {
    if (!c) return;
    const ask = askFromRoute();
    if (ask && ask.challenge !== signin.ask.value?.challenge) void signin.prepare(ask);
  },
);

onMounted(async () => {
  // Seed the home community's sign-in site from the descriptor so it is
  // pre-trusted and shows the "your community" chip (spec story 12). A missing
  // descriptor or signin block simply leaves no home site.
  try {
    const descriptor = await getCommunityDescriptor();
    if (descriptor.signin?.url) {
      await knownDoors.seedHome(descriptor.signin.url, descriptor.community?.name ?? '');
    }
  } catch {
    /* no descriptor yet — the card still renders, just without the home mark */
  }

  const ask = askFromRoute();
  if (!ask) {
    notALink.value = true;
    return;
  }
  await signin.prepare(ask);
});

/**
 * Build the ask from the route query. The OS deep-link handler and the scanner
 * both route here with the `matou://signin` params carried as query params —
 * what the code offers among them, which is what makes this an unlock (#688).
 * A missing `present` is a door this app cannot answer, so the ask is refused
 * (never a guessed path).
 */
function askFromRoute(): SigninAsk | null {
  return signinAskFromQuery(route.query);
}

function onNotNow(): void {
  signin.notNow();
  onClose();
}

/**
 * Don't (WS-A1): the wallet remembers nothing and closes; the browser page keeps
 * waiting until its code expires (#535, story 11).
 */
function onDont(): void {
  onClose();
}

function onClose(): void {
  // Leave the card; a member reached it from the app, so return to the wallet.
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'dashboard' });
}
</script>
