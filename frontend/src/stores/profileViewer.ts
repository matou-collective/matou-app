import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useProfilesStore } from 'stores/profiles';

// App-wide singleton driving the read-only ProfileModal mounted in
// DashboardLayout. Any UserAvatar click calls open(aid).
export const useProfileViewer = defineStore('profileViewer', () => {
  const profilesStore = useProfilesStore();
  const openAid = ref<string | null>(null);

  const isOpen = computed(() => openAid.value !== null);

  const sharedProfile = computed<Record<string, unknown> | null>(() => {
    if (!openAid.value) return null;
    const p = profilesStore.communityProfiles.find((x) => x.data.aid === openAid.value);
    return (p?.data as Record<string, unknown>) ?? null;
  });

  const communityProfile = computed<Record<string, unknown> | null>(() => {
    if (!openAid.value) return null;
    const p = profilesStore.communityReadOnlyProfiles.find(
      (x) => x.data.userAID === openAid.value,
    );
    return (p?.data as Record<string, unknown>) ?? null;
  });

  async function open(aid: string): Promise<void> {
    if (!aid) return;
    if (profilesStore.communityProfiles.length === 0) {
      await profilesStore.loadCommunityProfiles();
    }
    if (profilesStore.communityReadOnlyProfiles.length === 0) {
      await profilesStore.loadCommunityReadOnlyProfiles();
    }
    // Only open if we actually have a profile to show.
    const found = profilesStore.communityProfiles.some((x) => x.data.aid === aid);
    if (found) openAid.value = aid;
  }

  function close(): void {
    openAid.value = null;
  }

  return { openAid, isOpen, sharedProfile, communityProfile, open, close };
});
