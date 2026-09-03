<template>
  <div class="claim-welcome-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <OnboardingHeader
      :title="`Welcome, ${aidInfo?.name || 'Member'}`"
      subtitle="You've been invited to join Mātou"
      :show-back-button="true"
      @back="emit('back')"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <!-- Identity Preview -->
        <div v-if="aidInfo" class="identity-card bg-card border border-border rounded-xl p-5">
          <div class="flex items-start gap-3">
            <div class="icon-box bg-accent/20 p-2 rounded-lg shrink-0">
              <Fingerprint class="w-5 h-5 text-accent" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-medium mb-1">Your Identity</h3>
              <p class="text-sm text-muted-foreground mb-2">{{ aidInfo.name }}</p>
              <div class="aid-preview bg-secondary/50 rounded-lg px-3 py-2">
                <code class="text-xs font-mono text-foreground/80 break-all">
                  {{ formatAid(aidInfo.prefix) }}
                </code>
              </div>
            </div>
          </div>
        </div>

        <!-- Invitation Notice -->
        <div class="notice-box bg-primary/10 border border-primary/20 rounded-2xl p-5">
          <div class="flex items-start gap-3">
            <div class="icon-box bg-primary/20 p-2 rounded-lg shrink-0">
              <Info class="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 class="mb-1">Invitation</h3>
              <p class="text-sm text-muted-foreground">
                An administrator has created a verified identity for you. By accepting this
                invitation, your cryptographic keys will be rotated for security and your
                membership credentials will be activated.
              </p>
            </div>
          </div>
        </div>

        <!-- Matou Information Content -->
        <MatouInformationContent />
      </div>
    </div>

    <!-- Footer -->
    <div class="p-6 md:p-8 border-t border-border pb-safe-area">
      <div class="max-w-2xl mx-auto">
        <MBtn
          class="w-full h-12 text-base rounded-xl"
          @click="handleContinue"
        >
          I agree, accept invitation
          <ArrowRight class="w-4 h-4 ml-2" />
        </MBtn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, Fingerprint, Info } from 'lucide-vue-next';
import MBtn from '../base/MBtn.vue';
import MatouInformationContent from './MatouInformationContent.vue';
import OnboardingHeader from './OnboardingHeader.vue';
import { useOnboardingStore } from 'stores/onboarding';

const store = useOnboardingStore();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();

const aidInfo = store.claimAidInfo;

function formatAid(prefix: string): string {
  if (prefix.length <= 16) return prefix;
  return `${prefix.substring(0, 8)}...${prefix.substring(prefix.length - 4)}`;
}

function handleContinue() {
  emit('continue');
}
</script>

<style lang="scss" scoped>
.claim-welcome-screen {
  background-color: var(--matou-background);
}


.icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
}

.identity-card {
  background-color: var(--matou-card);
}

.notice-box {
  background-color: rgba(30, 95, 116, 0.1);
  border-color: rgba(30, 95, 116, 0.2);
}

.aid-preview {
  background-color: var(--matou-secondary);
}
</style>
