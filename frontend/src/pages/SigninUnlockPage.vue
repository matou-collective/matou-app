<template>
  <div class="signin-unlock-page h-full flex flex-col bg-background">
    <div class="flex-1 overflow-y-auto py-8">
      <UnlockCard
        :view="unlock.view.value"
        :phase="unlock.phase.value"
        :refusal="unlock.refusal.value"
        @unlock="unlock.unlock"
        @not-now="onNotNow"
        @try-again="unlock.tryAgain"
        @retry="unlock.retry"
        @close="onClose"
      />
      <p v-if="notALink" class="text-center text-sm text-muted-foreground mt-6">
        That doesn't look like an unlock code.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UnlockCard from 'src/components/signin/UnlockCard.vue';
import { useUnlock } from 'src/composables/useUnlock';
import type { UnlockAsk } from 'src/lib/signin/link';

const route = useRoute();
const router = useRouter();
const unlock = useUnlock();

const notALink = ref(false);

/** Close the card after a beat once the panel confirms the unlock (PU-A4). */
watch(unlock.phase, (p) => {
  if (p === 'done') setTimeout(onClose, 1500);
});

onMounted(async () => {
  const ask = askFromRoute();
  if (!ask) {
    notALink.value = true;
    return;
  }
  await unlock.prepare(ask);
});

/**
 * Build the unlock ask from the route query. The OS deep-link handler and the
 * scanner both route here with the `matou://unlock` params (`panel`, `present`,
 * `u`, `ek`, `name`, `t`, `exp`) carried as query params. A missing `panel`,
 * `present`, `u` or `ek` is an unlock this app cannot answer, so it is refused.
 */
function askFromRoute(): UnlockAsk | null {
  const q = route.query;
  const panel = str(q.panel);
  const present = str(q.present);
  const challenge = str(q.u);
  const sealingKey = str(q.ek);
  if (!panel || !present || !challenge || !sealingKey) return null;
  const expRaw = Number.parseInt(str(q.exp), 10);
  return {
    panel,
    present,
    challenge,
    sealingKey,
    community: str(q.name),
    signedInAt: str(q.t),
    expiresAt: Number.isFinite(expRaw) && expRaw > 0 ? expRaw * 1000 : null,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
}

function onNotNow(): void {
  unlock.notNow();
  onClose();
}

function onClose(): void {
  // Leave the card; a steward reached it from the app, so return to the wallet.
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'dashboard' });
}
</script>
