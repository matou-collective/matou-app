/**
 * The fake backend's data: one fresh world per scenario, built from the same
 * people `scenarios.ts` names so the fake KERIA wallet and the fake backend
 * agree on who is a member. Mutations (a registration sent, a message posted)
 * land in the world and last until the scenario is restarted.
 */
import { APPLICANTS, MEMBERS, ORG, PEOPLE, type Person, type PersonId, type Scenario } from './scenarios';

export interface ObjectPayload {
  id: string;
  type: string;
  ownerKey: string;
  data: Record<string, unknown>;
  timestamp: number;
  version: number;
}

export interface World {
  scenario: Scenario;
  communityName: string;
  /** Profiles by type name (SharedProfile, CommunityProfile, PrivateProfile, …). */
  profiles: Record<string, ObjectPayload[]>;
  /** AIDs with community space access. */
  memberAids: Set<string>;
  /** The backend identity the wallet set (POST /identity/set). */
  identity: { aid: string; configured: boolean } | null;
  /** Uploaded files by ref. */
  files: Map<string, { type: string; body: Buffer }>;
  /** Anything else a route wants to keep (chat, notices, … — see backendRoutes.ts). */
  extra: Record<string, unknown>;
}

const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.parse('2026-09-25T09:00:00.000Z');
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const avatarRef = (id: PersonId) => `harness-avatar-${id}`;

function sharedProfile(id: PersonId, p: Person, status: 'approved' | 'pending', joinedDaysAgo: number): ObjectPayload {
  return {
    id: `SharedProfile-${p.aid}`,
    type: 'SharedProfile',
    ownerKey: p.aid,
    timestamp: NOW - joinedDaysAgo * DAY,
    version: 1,
    data: {
      aid: p.aid,
      status,
      displayName: p.name,
      bio: p.bio,
      avatar: avatarRef(id),
      location: p.location,
      joinReason: status === 'pending' ? `I'd like to help with ${p.interests[0]?.toLowerCase() ?? 'the community'}.` : '',
      indigenousCommunity: 'Te Whānau-ā-Harness',
      participationInterests: [...p.interests],
      customInterests: '',
      skills: [],
      languages: ['English', 'te reo Māori'],
      publicEmail: p.email,
      publicLinks: [],
      // what the steward's registration list reads for a backend-only applicant
      ...(status === 'pending' ? { email: p.email, interests: [...p.interests] } : {}),
      lastActiveAt: iso(-joinedDaysAgo * 3600 * 1000),
      createdAt: iso(-joinedDaysAgo * DAY),
      updatedAt: iso(-joinedDaysAgo * DAY),
      typeVersion: 1,
    },
  };
}

export function communityProfile(p: Person, joinedDaysAgo: number): ObjectPayload {
  const steward = p.role.toLowerCase().includes('founding') || p.role.toLowerCase().includes('steward');
  return {
    id: `CommunityProfile-${p.aid}`,
    type: 'CommunityProfile',
    ownerKey: ORG.aid,
    timestamp: NOW - joinedDaysAgo * DAY,
    version: 1,
    data: {
      userAID: p.aid,
      credential: `EHarnessCred${p.aid.slice(8, 20)}`,
      role: p.role,
      memberSince: iso(-joinedDaysAgo * DAY),
      lastActiveAt: iso(-3600 * 1000),
      credentials: [],
      permissions: steward
        ? ['read', 'comment', 'vote', 'propose', 'moderate', 'admin']
        : ['read', 'comment', 'vote', 'propose'],
      communityCredentials: [],
    },
  };
}

export function buildWorld(scenario: Scenario, communityName: string): World {
  const joined: Record<string, number> = { aroha: 120, tama: 60, mere: 30 };
  const shared: ObjectPayload[] = [];
  const community: ObjectPayload[] = [];
  for (const id of MEMBERS) {
    shared.push(sharedProfile(id, PEOPLE[id], 'approved', joined[id] ?? 10));
    community.push(communityProfile(PEOPLE[id], joined[id] ?? 10));
  }
  APPLICANTS.forEach((id, i) => shared.push(sharedProfile(id, PEOPLE[id], 'pending', i + 1)));

  const me = scenario.signedInAs ? PEOPLE[scenario.signedInAs] : null;
  return {
    scenario,
    communityName,
    profiles: { SharedProfile: shared, CommunityProfile: community, PrivateProfile: [] },
    memberAids: new Set(MEMBERS.map((id) => PEOPLE[id].aid)),
    identity: me ? { aid: me.aid, configured: true } : null,
    files: new Map(),
    extra: {},
  };
}

/** A person's initial on their colour — what the fake file store serves as an avatar. */
export function avatarSvg(id: PersonId): string {
  const p = PEOPLE[id];
  const initials = p.name.split(' ').map((w) => w[0]).join('').slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="${p.tone}"/>
  <text x="64" y="64" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="52" font-weight="600" fill="#fff">${initials}</text>
</svg>`;
}
