<template>
  <div class="signin-approve-page h-full flex flex-col bg-background">
    <div class="flex-1 overflow-y-auto py-8">
      <!-- WS-A1: an unmet sign-in site stops here before any card (#535). -->
      <FirstContact
        v-if="signin.phase.value === 'first-contact' && signin.view.value"
        :address="signin.view.value.siteAddress"
        :claimed-name="signin.ask.value?.community ?? ''"
        @trust="signin.trust"
        @dont="onDont"
      />
      <ApproveCard
        v-else
        :view="signin.view.value"
        :phase="signin.phase.value"
        :refusal="signin.refusal.value"
        :can-approve="canApprove"
        @approve="signin.approve"
        @not-now="onNotNow"
        @try-again="signin.tryAgain"
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
import { useSignin } from 'src/composables/useSignin';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import type { SigninAsk } from 'src/lib/signin/link';

const route = useRoute();
const router = useRouter();
const signin = useSignin();
const knownDoors = useKnownDoorsStore();

const notALink = ref(false);
const canApprove = computed(() => !!signin.chosen.value?.sad?.d);

/** Close the card after a beat once the door answers VERIFIED (WS-A2d). */
watch(signin.phase, (p) => {
  if (p === 'done') setTimeout(onClose, 1500);
});

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
 * both route here with the `matou://signin` params (`door`, `present`, `c`,
 * `s`, `name`, `service`) carried as query params. A missing `present` is a
 * door this app cannot answer, so the ask is refused (never a guessed path).
 */
function askFromRoute(): SigninAsk | null {
  const q = route.query;
  const door = str(q.door);
  const present = str(q.present);
  const challenge = str(q.c);
  if (!door || !present || !challenge) return null;
  return {
    door,
    present,
    challenge,
    schemas: str(q.s)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    community: str(q.name),
    service: str(q.service) || str(q.svc),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
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
