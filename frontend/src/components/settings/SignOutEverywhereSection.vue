<template>
  <!-- "Sign out of the control panel everywhere" — the steward's take-back
       (#665, idss #1935, ADR 0282 d.4 copy amended by DDR 0284). One blunt
       button: NO session list, NO device names, NO count — the wallet does not
       know how many computers were unlocked, and a number would be a claim the
       request cannot support. -->
  <section class="settings-card" data-test="signout-everywhere-section">
    <div class="card-header">
      <h3 class="card-title"><ShieldOff :size="18" /> Sign out of the control panel everywhere</h3>
    </div>

    <!-- Done state: NO count, plus the reassurance that the steward is unchanged. -->
    <template v-if="status === 'done'">
      <p class="soe-copy" data-test="signout-everywhere-done">
        <b>Signed out of the control panel everywhere.</b> Any computer that was
        unlocked will ask to sign in again.
      </p>
      <p class="soe-note">You're still a steward. Your app is unchanged.</p>
    </template>

    <!-- Failure: stated plainly, and NOTHING claims sessions were ended (AC4). -->
    <template v-else-if="status === 'failed'">
      <p class="soe-copy" data-test="signout-everywhere-failed">
        <b>Couldn't sign out of the control panel.</b> Nothing changed — no
        sessions were ended. Check your connection and try again.
      </p>
      <button
        type="button"
        class="soe-action-btn"
        data-test="signout-everywhere-retry"
        @click="retry"
      >
        <RotateCcw :size="16" />
        <span>Try again</span>
      </button>
    </template>

    <!-- Resting / working state: the copy and the one button. -->
    <template v-else>
      <p class="soe-copy">
        Locks steward actions on every computer you've unlocked. You stay a
        steward — this only ends what those computers can do.
      </p>
      <button
        type="button"
        class="soe-action-btn"
        data-test="signout-everywhere-btn"
        :disabled="status === 'working'"
        @click="signOut"
      >
        <Loader2 v-if="status === 'working'" :size="16" class="soe-spin" />
        <LogOut v-else :size="16" />
        <span>{{ status === 'working' ? 'Signing out…' : 'Sign out everywhere' }}</span>
      </button>
      <p class="soe-note">
        Signing out here tells those computers to forget your access. It can't
        take back anything already done with it.
      </p>
      <!-- The "replace your twelve words" line ships ONLY once idss #1914's re-key
           screen lands (DDR 0284 corrected ADR 0282 d.4's "change your passcode":
           on IDIP a steward holds twelve words, never a passcode). Until the
           screen exists, omit it — do not name a door nobody can walk through. -->
      <p v-if="REKEY_SCREEN_AVAILABLE" class="soe-note" data-test="signout-everywhere-rekey">
        If you think someone copied your access,
        <a href="#" @click.prevent="openRekey">replace your twelve words</a>.
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { LogOut, ShieldOff, RotateCcw, Loader2 } from 'lucide-vue-next';
import { useSignoutEverywhere } from 'src/composables/useSignoutEverywhere';

/**
 * Whether idss #1914's re-key ("replace your twelve words") screen exists. While
 * it does not, the second copy line is absent (AC5). Flip this to `true` and wire
 * {@link openRekey} to the re-key route the moment #1914 lands.
 */
const REKEY_SCREEN_AVAILABLE = false;

const { status, signOut, reset } = useSignoutEverywhere();

function retry(): void {
  reset();
  void signOut();
}

function openRekey(): void {
  // Wired when idss #1914's re-key screen lands; unreachable while
  // REKEY_SCREEN_AVAILABLE is false.
}
</script>

<style scoped>
.settings-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.card-header {
  margin-bottom: 1.25rem;
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground, #1f2937);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.soe-copy {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground, #6b7280);
  margin: 0 0 1rem;
  line-height: 1.5;
}

.soe-note {
  font-size: 0.8125rem;
  color: var(--matou-muted-foreground, #6b7280);
  margin: 1.25rem 0 0;
  line-height: 1.5;
}

.soe-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.5rem;
  border: 1px solid var(--matou-border, #d1e7ea);
  background: var(--matou-card, white);
  color: var(--matou-foreground, #1f2937);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.soe-action-btn:hover:not(:disabled) {
  background: #f0f9fa;
  border-color: #a8d4da;
}

.soe-action-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.soe-spin {
  animation: soe-spin 1s linear infinite;
}

@keyframes soe-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
