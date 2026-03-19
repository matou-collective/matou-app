/**
 * Composable for consuming Server-Sent Events from the backend.
 * Listens for credential and space events to trigger reactive UI updates.
 *
 * Singleton: one SSE connection is shared across all components that call
 * useBackendEvents().  DashboardLayout connects on mount; child pages
 * (ActivityPage, etc.) can watch `lastEvent` without opening a second socket.
 */
import { ref } from 'vue';
import { Notify } from 'quasar';
import { useRouter } from 'vue-router';
import { BACKEND_URL } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { useChatStore } from 'stores/chat';

export type BackendEventType =
  | 'credential:new'
  | 'credential:community'
  | 'space:joined'
  | 'identity:configured'
  | 'notice_created'
  | 'notice_published'
  | 'notice_archived'
  | 'notice_comment'
  | 'notice_reaction'
  | 'profile:updated'
  | 'chat:message:new'
  | 'chat:message:edit'
  | 'chat:message:delete'
  | 'chat:reaction:add'
  | 'chat:reaction:remove'
  | 'chat:channel:new'
  | 'chat:channel:update'
  | 'proposal:submitted'
  | 'proposal:endorsed'
  | 'proposal:approved'
  | 'proposal:rejected'
  | 'proposal:status_changed'
  | 'project:created'
  | 'contribution:assigned'
  | 'contribution:needs_review'
  | 'contribution:approved'
  | 'contribution:declined'
  | 'contribution:registered'
  | 'contribution:reviewed'
  | 'contribution:shared'
  | 'contribution:confirmed'
  | 'contribution:accepted'
  | 'contribution:signed_off'
  | 'contribution:updated'
  | 'contribution_updated'
  | 'plan_updated'
  | 'project_updated'
  | 'milestone_updated'
  | 'decision_plan:submitted'
  | 'decision_plan:signed_off'
  | 'governance_action:completed'
  | 'connected';

export interface BackendEvent {
  type: BackendEventType;
  data: Record<string, string>;
}

// Module-level singleton state — shared by every caller of useBackendEvents()
const connected = ref(false);
const lastEvent = ref<BackendEvent | null>(null);
let eventSource: EventSource | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

// Debounce profile reloads — any-sync can fire many profile:updated events in quick succession
let profileDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedProfileReload() {
  if (profileDebounceTimer) clearTimeout(profileDebounceTimer);
  profileDebounceTimer = setTimeout(async () => {
    const profilesStore = useProfilesStore();
    await Promise.all([
      profilesStore.loadCommunityProfiles(),
      profilesStore.loadCommunityReadOnlyProfiles(),
    ]);
    profileDebounceTimer = null;
  }, 2000);
}

/** Safely parse SSE event data. Returns null on failure. */
function safeParse(event: MessageEvent): Record<string, string> | null {
  try {
    return JSON.parse(event.data);
  } catch {
    console.warn('[BackendEvents] Malformed event data:', event.data);
    return null;
  }
}

function connect() {
  if (eventSource) return;

  const url = `${BACKEND_URL}/api/v1/events`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('connected', () => {
    connected.value = true;
    console.log('[BackendEvents] Connected to SSE stream');
  });

  eventSource.addEventListener('credential:new', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'credential:new', data };
    console.log('[BackendEvents] New credential:', data.said);
  });

  eventSource.addEventListener('credential:community', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'credential:community', data };
    console.log('[BackendEvents] Community credential:', data.said);

    // Refresh community data in identity store
    const identityStore = useIdentityStore();
    identityStore.fetchUserSpaces().catch(() => {});
  });

  eventSource.addEventListener('space:joined', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'space:joined', data };
    console.log('[BackendEvents] Space joined:', data.spaceId);

    const identityStore = useIdentityStore();
    identityStore.fetchUserSpaces().catch(() => {});
  });

  eventSource.addEventListener('identity:configured', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'identity:configured', data };
    console.log('[BackendEvents] Identity configured:', data.aid);
  });

  eventSource.addEventListener('notice_created', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'notice_created', data };
    console.log('[BackendEvents] Notice created:', data.noticeId);
  });

  eventSource.addEventListener('notice_published', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'notice_published', data };
    console.log('[BackendEvents] Notice published:', data.noticeId);
  });

  eventSource.addEventListener('notice_archived', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'notice_archived', data };
    console.log('[BackendEvents] Notice archived:', data.noticeId);
  });

  eventSource.addEventListener('notice_comment', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'notice_comment', data };
    console.log('[BackendEvents] Notice comment:', data.noticeId);
  });

  eventSource.addEventListener('notice_reaction', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'notice_reaction', data };
    console.log('[BackendEvents] Notice reaction:', data.noticeId);
  });

  eventSource.addEventListener('profile:updated', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'profile:updated', data };
    debouncedProfileReload();
  });

  // --- Chat events ---
  const chatStore = useChatStore();
  const router = useRouter();

  eventSource.addEventListener('chat:message:new', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:new', data };
    chatStore.handleNewMessage(data);

    // Toast notification for messages in non-active channels
    if (data.channelId !== chatStore.currentChannelId) {
      const channel = chatStore.channels.find((c: { id: string }) => c.id === data.channelId);
      const channelName = channel?.name ?? 'Unknown';
      const content = data.content as string | undefined;
      const contentPreview = content?.substring(0, 80) ?? '';
      const profilesStore = useProfilesStore();
      const profile = profilesStore.profilesByAid[data.senderAid as string];
      const displayName = profile?.displayName || data.senderName;
      Notify.create({
        html: true,
        message: `<strong>${displayName}</strong><br>${contentPreview}`,
        caption: `#${channelName}`,
        position: 'top-right',
        timeout: 5000,
        color: 'primary',
        actions: [
          {
            label: 'View',
            color: 'white',
            handler: () => {
              router.push({ name: 'chat' });
              chatStore.selectChannel(data.channelId as string);
            },
          },
          { label: 'Dismiss', color: 'white' },
        ],
      });
    }
  });

  eventSource.addEventListener('chat:message:edit', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:edit', data };
    chatStore.handleEditMessage(data);
  });

  eventSource.addEventListener('chat:message:delete', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:delete', data };
    chatStore.handleDeleteMessage(data);
  });

  eventSource.addEventListener('chat:reaction:add', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:reaction:add', data };
    if (chatStore.currentChannelId) {
      chatStore.loadMessages(chatStore.currentChannelId);
    }
  });

  eventSource.addEventListener('chat:reaction:remove', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:reaction:remove', data };
    if (chatStore.currentChannelId) {
      chatStore.loadMessages(chatStore.currentChannelId);
    }
  });

  eventSource.addEventListener('chat:channel:new', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:channel:new', data };
    chatStore.handleNewChannel(data);
  });

  eventSource.addEventListener('chat:channel:update', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:channel:update', data };
    chatStore.handleUpdateChannel(data);
  });

  // --- Proposal events with reactive handling ---
  eventSource.addEventListener('proposal:endorsed', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'proposal:endorsed', data };
    console.log('[BackendEvents] proposal:endorsed:', data);
    if (data.threshold_met === 'true') {
      Notify.create({
        message: 'Endorsement threshold met! Proposal moved to In Review.',
        color: 'positive',
        position: 'top-right',
        timeout: 5000,
      });
    }
  });

  eventSource.addEventListener('proposal:status_changed', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'proposal:status_changed', data };
    console.log('[BackendEvents] proposal:status_changed:', data);
  });

  eventSource.addEventListener('governance_action:completed', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'governance_action:completed', data };
    console.log('[BackendEvents] governance_action:completed:', data);
  });

  // --- Other contribution system events (generic handler) ---
  const contribEventTypes: BackendEventType[] = [
    'proposal:submitted',
    'proposal:approved',
    'proposal:rejected',
    'project:created',
    'contribution:assigned',
    'contribution:needs_review',
    'contribution:approved',
    'contribution:declined',
    'contribution:registered',
    'contribution:reviewed',
    'contribution:shared',
    'contribution:confirmed',
    'contribution:accepted',
    'contribution:signed_off',
    'contribution:updated',
    'contribution_updated',
    'plan_updated',
    'project_updated',
    'milestone_updated',
    'decision_plan:submitted',
    'decision_plan:signed_off',
  ];

  for (const eventType of contribEventTypes) {
    eventSource.addEventListener(eventType, (event) => {
      const data = safeParse(event);
      if (!data) return;
      lastEvent.value = { type: eventType, data };
      console.log(`[BackendEvents] ${eventType}:`, data);
    });
  }

  eventSource.onerror = () => {
    connected.value = false;
    eventSource?.close();
    eventSource = null;

    // Reconnect after delay
    reconnectTimeout = setTimeout(() => {
      console.log('[BackendEvents] Reconnecting...');
      connect();
    }, 5000);
  };
}

function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  connected.value = false;
}

export function useBackendEvents() {
  return {
    connected,
    lastEvent,
    connect,
    disconnect,
  };
}
