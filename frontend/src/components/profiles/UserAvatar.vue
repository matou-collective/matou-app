<template>
  <div
    class="user-avatar"
    :class="[gradientClass, { clickable: isClickable }]"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="img"
    :aria-label="displayName || 'avatar'"
    @click="onClick"
  >
    <img
      v-if="src && !imgError"
      :src="src"
      :alt="displayName"
      class="user-avatar-img"
      @error="imgError = true"
    />
    <span v-else class="user-avatar-initials" :style="{ fontSize: Math.round(size * 0.4) + 'px' }">
      {{ initials }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useProfilesStore } from 'stores/profiles';
import { useProfileViewer } from 'stores/profileViewer';
import { getFileUrl } from 'src/lib/api/client';
import { avatarInitials, avatarGradientClass, resolveAvatarSrc } from 'src/lib/avatar';

interface Props {
  aid?: string;
  name?: string;
  src?: string;
  size?: number;
  clickable?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  aid: '',
  name: '',
  src: '',
  size: 32,
  clickable: true,
});

const profilesStore = useProfilesStore();
const profileViewer = useProfileViewer();
const imgError = ref(false);

const resolved = computed(() => (props.aid ? profilesStore.profilesByAid[props.aid] : undefined));

const displayName = computed(() => {
  if (props.name) return props.name;
  if (resolved.value?.displayName) return resolved.value.displayName;
  if (props.aid) return props.aid.slice(0, 12) + '…';
  return '';
});

const src = computed(() => {
  const r = props.src || resolved.value?.avatar || '';
  return resolveAvatarSrc(r, getFileUrl);
});

const initials = computed(() => avatarInitials(displayName.value));
const gradientClass = computed(() => (src.value ? '' : avatarGradientClass(displayName.value)));

const isClickable = computed(() => props.clickable && !!props.aid);

function onClick(e: MouseEvent) {
  if (!isClickable.value) return;
  e.stopPropagation();
  void profileViewer.open(props.aid);
}
</script>

<style scoped lang="scss">
.user-avatar {
  border-radius: 9999px;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--matou-secondary);
  color: #fff;
  user-select: none;
  &.clickable { cursor: pointer; }
  &.clickable:hover { box-shadow: 0 0 0 2px var(--matou-accent); }
  &.gradient-1 { background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent)); }
  &.gradient-2 { background: linear-gradient(135deg, var(--matou-accent), var(--matou-chart-2)); }
  &.gradient-3 { background: linear-gradient(135deg, var(--matou-chart-2), var(--matou-primary)); }
  &.gradient-4 { background: linear-gradient(135deg, rgba(30,95,116,0.8), rgba(74,157,156,0.8)); }
}
.user-avatar-img { width: 100%; height: 100%; object-fit: cover; }
.user-avatar-initials { font-weight: 600; line-height: 1; }
</style>
