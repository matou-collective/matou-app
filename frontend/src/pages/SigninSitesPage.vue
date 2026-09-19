<template>
  <!-- WS-A3: "Sign-in sites you trust" (idss spec #1492 story 19, #535). One row
       per known door — name, address, first met, last used — the home site first
       and marked "your community" with no Forget, every other row Forgettable.
       There is no way to add a site by hand: a site is only ever added by
       trusting it at first contact. -->
  <div class="signin-sites">
    <div class="settings-header">
      <button class="back-btn" @click="goBack" aria-label="Back">
        <ArrowLeft :size="20" />
      </button>
      <div>
        <h1 class="header-title">Sign-in sites you trust</h1>
        <p class="header-subtitle">Sites you can sign in to with your identity</p>
      </div>
    </div>

    <div class="settings-content">
      <p class="intro">
        You meet a sign-in site the first time you sign in there and agree to
        trust it. Your community's own site is trusted from the start. Forget any
        site you no longer use — the site is told nothing, and you'll be asked
        again the next time it appears.
      </p>

      <p v-if="rows.length === 0" class="empty" data-field="empty">
        No sign-in sites yet.
      </p>

      <ul v-else class="site-list" data-field="site-list">
        <li
          v-for="row in rows"
          :key="row.url"
          class="site-row"
          data-field="site-row"
          :data-home="row.isHome ? 'true' : 'false'"
        >
          <div class="site-main">
            <div class="site-name-line">
              <span class="site-name" data-field="name">{{ row.name }}</span>
              <span v-if="row.isHome" class="home-chip" data-field="home-mark">your community</span>
            </div>
            <div class="site-address" data-field="address">{{ address(row.url) }}</div>
            <div class="site-meta">
              <span>First met {{ formatDate(row.firstMet) }}</span>
              <span aria-hidden="true">·</span>
              <span>Last used {{ formatDate(row.lastUsed) }}</span>
            </div>
          </div>
          <button
            v-if="!row.isHome"
            type="button"
            class="forget-btn"
            data-action="forget"
            @click="onForget(row.url)"
          >
            Forget
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft } from 'lucide-vue-next';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { siteAddress } from 'src/lib/signin/view';
import { formatDate } from 'src/lib/formatDate';

const router = useRouter();
const knownDoors = useKnownDoorsStore();

const rows = computed(() => knownDoors.rows);

onMounted(async () => {
  await knownDoors.load();
  // Seed the home site so it appears even before the member has signed in once
  // (story 12). A missing descriptor simply leaves the list to the sites met.
  try {
    const descriptor = await getCommunityDescriptor();
    if (descriptor.signin?.url) {
      await knownDoors.seedHome(descriptor.signin.url, descriptor.community?.name ?? '');
    }
  } catch {
    /* no descriptor yet — show whatever sites have been met */
  }
});

/** The site line shows the address, not the raw URL. */
function address(url: string): string {
  return siteAddress(url);
}

async function onForget(url: string): Promise<void> {
  await knownDoors.forget(url);
}

function goBack(): void {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'account-settings' });
}
</script>

<style scoped>
.signin-sites {
  min-height: 100%;
  background: var(--background, #fff);
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.25rem 1rem;
  background: linear-gradient(135deg, var(--primary, #2d6a4f), var(--primary-dark, #1b4332));
  color: #fff;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: none;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  cursor: pointer;
}

.header-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
}

.header-subtitle {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.85;
}

.settings-content {
  max-width: 640px;
  margin: 0 auto;
  padding: 1rem;
}

.intro {
  font-size: 0.85rem;
  color: var(--muted-foreground, #6b7280);
  margin-bottom: 1rem;
}

.empty {
  color: var(--muted-foreground, #6b7280);
  font-size: 0.9rem;
  text-align: center;
  padding: 2rem 0;
}

.site-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.site-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 0.75rem;
  background: var(--card, #fff);
}

.site-name-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.site-name {
  font-weight: 600;
}

.home-chip {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 0.375rem;
  background: rgba(45, 106, 79, 0.12);
  color: var(--primary, #2d6a4f);
}

.site-address {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  color: var(--muted-foreground, #6b7280);
  word-break: break-all;
  margin-top: 0.15rem;
}

.site-meta {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  font-size: 0.75rem;
  color: var(--muted-foreground, #6b7280);
  margin-top: 0.35rem;
}

.forget-btn {
  flex-shrink: 0;
  border: 1px solid var(--border, #e5e7eb);
  background: transparent;
  color: var(--destructive, #b91c1c);
  border-radius: 0.5rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.forget-btn:hover {
  background: rgba(185, 28, 28, 0.08);
}
</style>
