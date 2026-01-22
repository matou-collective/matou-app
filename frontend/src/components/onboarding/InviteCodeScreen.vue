<template>
  <div class="invite-code-screen h-full flex flex-col bg-background">
    <!-- Header -->
    <div class="p-6 md:p-8 pb-4 border-b border-border">
      <div class="flex items-center justify-between mb-4">
        <button
          class="text-muted-foreground hover:text-foreground transition-colors"
          @click="onBack"
        >
          <ArrowLeft class="w-5 h-5" />
        </button>
        <MBtn variant="ghost" size="sm" class="text-xs" @click="handleQuickDemo">
          Quick Demo
        </MBtn>
      </div>
      <h1 class="mb-2">Welcome to Matou</h1>
      <p class="text-muted-foreground">Enter your invite code to join the community</p>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 md:p-8">
      <form class="space-y-6 max-w-md mx-auto" @submit.prevent="handleSubmit">
        <div class="space-y-2">
          <label class="text-sm font-medium" for="inviteCode">Invite Code</label>
          <MInput
            id="inviteCode"
            v-model="inviteCode"
            placeholder="XXXX-XXXX-XXXX"
            :error="!!error"
            :error-message="error"
            @update:model-value="error = ''"
          />
          <template v-if="error">
            <div class="flex items-center gap-2 text-destructive text-sm mt-2">
              <AlertCircle class="w-4 h-4" />
              <span>{{ error }}</span>
            </div>
          </template>
        </div>

        <div class="info-box bg-secondary/50 border border-border rounded-xl p-4 md:p-5 flex gap-3">
          <Info class="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div class="text-sm">
            <p class="mb-2">
              Invite codes are distributed by existing Matou members to ensure trusted
              community growth.
            </p>
            <a href="#" class="text-primary hover:underline" @click.prevent="showLearnMore">
              Learn how to get an invite code &rarr;
            </a>
          </div>
        </div>

        <MBtn type="submit" class="w-full" :loading="isValidating">
          {{ isValidating ? 'Verifying...' : 'Continue' }}
        </MBtn>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ArrowLeft, AlertCircle, Info } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import MBtn from '../base/MBtn.vue';
import MInput from '../base/MInput.vue';
import { useKERIClient } from 'src/lib/keri/client';

const $q = useQuasar();
const keriClient = useKERIClient();

const inviteCode = ref('');
const error = ref('');
const isValidating = ref(false);

const emit = defineEmits<{
  (e: 'continue', inviterName: string): void;
  (e: 'back'): void;
}>();

const onBack = () => {
  emit('back');
};

const handleSubmit = async () => {
  error.value = '';

  if (!inviteCode.value.trim()) {
    error.value = 'Please enter an invite code';
    return;
  }

  if (inviteCode.value.length < 8) {
    error.value = 'Invite code must be at least 8 characters';
    return;
  }

  isValidating.value = true;

  try {
    const result = await keriClient.verifyInviteCode(inviteCode.value);
    if (result.valid) {
      $q.notify({
        type: 'positive',
        message: 'Invite code verified!',
        position: 'top',
      });
      emit('continue', result.inviterName);
    }
  } catch (err) {
    error.value = 'Invalid invite code. Please check and try again.';
  } finally {
    isValidating.value = false;
  }
};

const handleQuickDemo = async () => {
  inviteCode.value = 'DEMO-CODE-2024';
  isValidating.value = true;

  try {
    const result = await keriClient.verifyInviteCode(inviteCode.value);
    $q.notify({
      type: 'positive',
      message: 'Demo code applied!',
      position: 'top',
    });
    emit('continue', result.inviterName);
  } catch (err) {
    error.value = 'Demo failed';
  } finally {
    isValidating.value = false;
  }
};

const showLearnMore = () => {
  $q.notify({
    type: 'info',
    message: 'Visit matou.dao/invite to learn more',
    position: 'top',
  });
};
</script>

<style lang="scss" scoped>
.invite-code-screen {
  background-color: var(--matou-background);
}

.info-box {
  background-color: rgba(232, 244, 248, 0.5);
}

:deep(.m-input) input {
  text-transform: uppercase;
}
</style>
