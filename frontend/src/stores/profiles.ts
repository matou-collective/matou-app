import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  getMyProfiles,
  getProfiles,
  createOrUpdateProfile,
  type ObjectPayload,
} from 'src/lib/api/client';

export const useProfilesStore = defineStore('profiles', () => {
  const myProfiles = ref<Record<string, ObjectPayload[]>>({});
  const communityProfiles = ref<ObjectPayload[]>([]);
  const communityReadOnlyProfiles = ref<ObjectPayload[]>([]);
  const loading = ref(false);

  async function loadMyProfiles(): Promise<void> {
    try {
      myProfiles.value = await getMyProfiles();
      console.log('[ProfilesStore] Loaded my profiles:', Object.keys(myProfiles.value));
    } catch (err) {
      console.warn('[ProfilesStore] Failed to load my profiles:', err);
    }
  }

  async function loadCommunityProfiles(): Promise<void> {
    loading.value = true;
    try {
      communityProfiles.value = await getProfiles('SharedProfile');
      console.log(`[ProfilesStore] Loaded ${communityProfiles.value.length} SharedProfiles`);
    } catch (err) {
      console.warn('[ProfilesStore] Failed to load community profiles:', err);
    } finally {
      loading.value = false;
    }
  }

  async function loadCommunityReadOnlyProfiles(): Promise<void> {
    try {
      communityReadOnlyProfiles.value = await getProfiles('CommunityProfile');
      console.log(`[ProfilesStore] Loaded ${communityReadOnlyProfiles.value.length} CommunityProfiles`);
    } catch (err) {
      console.warn('[ProfilesStore] Failed to load community read-only profiles:', err);
    }
  }

  async function saveProfile(
    typeName: string,
    data: Record<string, unknown>,
    options?: { id?: string; spaceId?: string }
  ): Promise<{ success: boolean; objectId?: string; error?: string }> {
    const result = await createOrUpdateProfile(typeName, data, options);
    if (result.success) {
      // Refresh profiles after save
      await loadMyProfiles();
    }
    return result;
  }

  function getMyProfile(typeName: string): ObjectPayload | null {
    const profiles = myProfiles.value[typeName];
    if (!profiles || profiles.length === 0) return null;
    // Return the latest version
    return profiles.reduce((latest, p) =>
      p.version > latest.version ? p : latest
    );
  }

  const profilesByAid = computed(() => {
    const map: Record<string, { displayName: string; avatar: string }> = {};
    for (const p of communityProfiles.value) {
      const aid = p.data.aid as string;
      if (aid) {
        map[aid] = {
          displayName: (p.data.displayName as string) || '',
          avatar: (p.data.avatar as string) || '',
        };
      }
    }
    return map;
  });

  return {
    myProfiles,
    communityProfiles,
    communityReadOnlyProfiles,
    profilesByAid,
    loading,
    loadMyProfiles,
    loadCommunityProfiles,
    loadCommunityReadOnlyProfiles,
    saveProfile,
    getMyProfile,
  };
});
