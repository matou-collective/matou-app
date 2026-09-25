/**
 * The fake backend's dashboard routes — members, role policy, chat, notices,
 * projects — answered from the world `backendWorld.ts` builds.
 *
 * Each world gets its own copy of `fixtures/community.ts` on first use (see
 * {@link dash}), so a message posted or an RSVP changed shows on the next
 * refetch and lasts until the scenario resets. Envelopes follow the Go handlers
 * in backend/internal/api (`{ channels }`, `{ notices }`, …); the shapes inside
 * are the frontend's own types in src/lib/api.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Req, Reply, Route } from './backendPlugin';
import { communityProfile, nextId, type ObjectPayload, type World } from './backendWorld';
import { CHANNELS, CONTRIBUTIONS, MESSAGES, NOTICES, PROJECTS, PROPOSALS, READ_CURSORS, SAVED } from './fixtures/community';
import { ORG, PEOPLE, type Person, type PersonId } from './scenarios';

const json = (value: unknown, status = 200): Reply => ({ status, json: value });
const ok = (extra: Record<string, unknown> = {}): Reply => json({ success: true, ...extra });
const notFound = (): Reply => json({ error: 'not found' }, 404);
const found = (value: unknown): Reply => (value ? json(value) : notFound());
const body = <T>(r: Req) => (r.body ?? {}) as T;
const now = () => new Date().toISOString();

// --- people

const byAid = (aid: string | null): Person | undefined => Object.values<Person>(PEOPLE).find((p) => p.aid === aid);
const nameOf = (aid: string | null) => byAid(aid)?.name ?? 'Someone';
const aidOf = (id: PersonId) => PEOPLE[id].aid;
/** Stewards hold a founding/steward role — the same scan the identity store does. */
const isSteward = (aid: string | null) => /founding|steward/i.test(byAid(aid)?.role ?? '');

/** A fixture keyed by person, re-keyed by AID. */
function byPerson<T, U>(rec: Partial<Record<PersonId, T>> | undefined, f: (v: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [aidOf(k as PersonId), f(v as T)]));
}

// --- the world's dashboard state

interface Msg {
  id: string; channelId: string; senderAid: string; senderName: string; content: string;
  replyTo?: string; sentAt: string; editedAt?: string; deletedAt?: string;
  attachments?: unknown[]; reactions: Record<string, string[]>; version: number;
}
type Rec = Record<string, unknown>;
type Notice = Rec & { id: string; type: string; state: string; pinned: boolean };
interface Comment { id: string; noticeId: string; userId: string; userDisplayName: string; text: string; createdAt: string }
interface Reaction { id: string; noticeId: string; userId: string; emoji: string; active: boolean; createdAt: string }
interface Dash {
  channels: Array<Rec & { id: string; isArchived: boolean; allowedRoles?: string[] }>;
  messages: Msg[];
  /** AID → channel → lastReadAt. */
  readCursors: Record<string, Record<string, string>>;
  /** AID → "type:id" → comment count seen. */
  commentCursors: Record<string, Record<string, number>>;
  notices: Notice[];
  /** Notice → AID → … (RSVP, ack time, save time). */
  rsvps: Record<string, Record<string, { status: string; updatedAt: string }>>;
  acks: Record<string, Record<string, string>>;
  saves: Record<string, Record<string, string>>;
  comments: Record<string, Comment[]>;
  reactions: Record<string, Reaction[]>;
  projects: Array<Rec & { id: string; proposal_ids: string[] }>;
  contributions: Array<Rec & { id: string; project_id: string; status: string }>;
  proposals: Array<Rec & { id: string }>;
  policy: Rec & { version: number };
}

function seed(policy: Rec & { version: number }): Dash {
  // Anchored to the moment the world is built, not the harness NOW: "40 min
  // ago" should read as such, and next week's hui must still be upcoming.
  const built = Date.now();
  const at = (offset: number) => new Date(built + offset).toISOString();
  const perNotice = <T>(f: (n: (typeof NOTICES)[number]) => T) => Object.fromEntries(NOTICES.map((n) => [n.id, f(n)]));
  return {
    channels: CHANNELS.map((c) => ({
      id: c.id, name: c.name, description: c.description, icon: c.icon,
      createdAt: at(c.createdAt), createdBy: aidOf(c.by), isArchived: false,
      ...(c.allowedRoles ? { allowedRoles: [...c.allowedRoles] } : {}),
    })),
    messages: MESSAGES.map((m) => ({
      id: m.id, channelId: m.channel, senderAid: aidOf(m.from), senderName: PEOPLE[m.from].name,
      content: m.text, sentAt: at(m.at), version: 1,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      reactions: Object.fromEntries(Object.entries(m.reactions ?? {}).map(([e, who]) => [e, who.map(aidOf)])),
    })),
    readCursors: byPerson(READ_CURSORS, (c) => Object.fromEntries(Object.entries(c).map(([ch, t]) => [ch, at(t)]))),
    commentCursors: {},
    notices: NOTICES.map((n) => ({
      id: n.id, type: n.type, title: n.title, summary: n.summary, body: n.body, pinned: n.pinned ?? false,
      issuerType: 'person', issuerId: aidOf(n.by), issuerDisplayName: PEOPLE[n.by].name, audienceMode: 'community',
      state: 'published', createdAt: at(n.at), createdBy: aidOf(n.by), publishAt: at(n.at), publishedAt: at(n.at),
      timezone: 'Pacific/Auckland',
      ...(n.ackRequired ? { ackRequired: true, ackDueAt: at(n.ackDueIn ?? 0) } : {}),
      ...(n.event ? {
        eventStart: at(n.event.start), eventEnd: at(n.event.start + n.event.hours * 3600_000),
        locationMode: n.event.url ? 'online' : 'in_person', locationText: n.event.where,
        ...(n.event.url ? { locationUrl: n.event.url } : {}),
        rsvpEnabled: true, ...(n.event.capacity ? { rsvpCapacity: n.event.capacity } : {}),
      } : {}),
    })),
    rsvps: perNotice((n) => byPerson(n.rsvps, (status) => ({ status, updatedAt: at(n.at) }))),
    acks: perNotice((n) => Object.fromEntries((n.acks ?? []).map((p) => [aidOf(p), at(n.at + 3600_000)]))),
    saves: byPerson(SAVED, (ids) => Object.fromEntries(ids.map((id) => [id, at(-3600_000)]))),
    comments: perNotice((n) => (n.comments ?? []).map((c, i) => ({
      id: `${n.id}-c${i}`, noticeId: n.id, userId: aidOf(c.from), userDisplayName: PEOPLE[c.from].name, text: c.text, createdAt: at(c.at),
    }))),
    reactions: perNotice((n) => Object.entries(n.reactions ?? {}).flatMap(([emoji, who]) => who.map((p) => ({
      id: `${n.id}-${p}-${emoji}`, noticeId: n.id, userId: aidOf(p), emoji, active: true, createdAt: at(n.at + 600_000),
    })))),
    projects: PROJECTS.map((p) => ({
      id: p.id, title: p.title, description: p.description, status: p.status, images: [], proposal_ids: [], implementation_plan_ids: [],
      project_steward_id: aidOf(p.steward), project_steward_name: PEOPLE[p.steward].name,
      project_lead_id: aidOf(p.lead), project_lead_name: PEOPLE[p.lead].name, budget: p.budget, duration: p.duration,
      ...('start' in p ? { start_date: at(p.start), end_date: at(p.end) } : {}),
      created_by: aidOf(p.steward), created_at: at(p.at), updated_at: at(p.at), comment_count: 0,
    })),
    contributions: CONTRIBUTIONS.map((c) => ({
      id: c.id, project_id: c.project, title: c.title, description: c.description, contribution_type: c.type,
      priority: c.priority, status: c.status, objectives: [], deliverables: [...c.deliverables], acceptance_criteria: [], skill_requirements: [],
      ...('deadline' in c ? { deadline: at(c.deadline) } : {}),
      ...('assignee' in c ? { assigned_contributor_id: aidOf(c.assignee) } : {}),
      created_by: aidOf(c.by), created_at: at(c.at), updated_at: at(c.at), comment_count: 0,
    })),
    proposals: PROPOSALS.map((p) => ({
      // the app files proposals under the proposer's KERIA alias, not their AID
      id: p.id, proposer_id: PEOPLE[p.by].alias, title: p.title, type: [...p.type], priority: p.priority, description: p.description,
      problem_statement: p.problem, solution: p.solution, expected_outcomes: [...p.outcomes], estimated_budget: p.budget,
      timeline: p.timeline, status: p.status, endorsement_threshold: 2, attachments: [], created_at: at(p.at), updated_at: at(p.at),
    })),
    policy: { ...policy },
  };
}

function messageView(m: Msg, me: string | null) {
  const { reactions, ...rest } = m;
  return {
    ...rest,
    reactions: Object.entries(reactions).filter(([, who]) => who.length)
      .map(([emoji, who]) => ({ emoji, count: who.length, reactorAids: who, hasReacted: !!me && who.includes(me) })),
  };
}

/** Mark an applicant approved, list them as a member and let them into the community space. */
function approve(world: World, aid: string, role = 'Member') {
  const sp = world.profiles.SharedProfile?.find((p) => p.data.aid === aid);
  if (sp) sp.data = { ...sp.data, status: 'approved', updatedAt: now() };
  const person = byAid(aid);
  const members = (world.profiles.CommunityProfile ??= []);
  if (person && !members.some((p) => p.data.userAID === aid)) {
    const profile = communityProfile({ ...person, role }, 0);
    profile.data = { ...profile.data, memberSince: now(), lastActiveAt: now() };
    members.push(profile);
  }
  if (aid) world.memberAids.add(aid);
}

/**
 * The dashboard routes. `root` is the frontend dir: the role policy is the Go
 * default, dumped to fixtures/rolePolicy.json (with the capabilities a Member
 * and a Founding Member hold, so `callerCapabilities` needs no policy engine).
 */
export function dashboardRoutes(root: string): Route[] {
  const POLICY = JSON.parse(readFileSync(join(root, 'tests/preview-harness/fixtures/rolePolicy.json'), 'utf8')) as Rec & {
    policy: Rec & { version: number };
    callerCapabilitiesByRole: Record<string, string[]>;
  };
  const dash = (w: World): Dash => (w.extra.dashboard ??= seed(POLICY.policy)) as Dash;
  const withNotice = (r: Req, m: RegExpMatchArray, f: (d: Dash, n: Notice) => Reply): Reply => {
    const d = dash(r.world);
    const n = d.notices.find((x) => x.id === decodeURIComponent(m[1]!));
    return n ? f(d, n) : notFound();
  };
  const message = (r: Req, m: RegExpMatchArray) => dash(r.world).messages.find((x) => x.id === decodeURIComponent(m[1]!));
  const channel = (r: Req, m: RegExpMatchArray) => dash(r.world).channels.find((c) => c.id === decodeURIComponent(m[1]!));
  const noComments = () => json({ comments: [], total: 0 });

  const community: Route[] = [
    ['GET', /^\/api\/v1\/community\/members$/, ({ world }) => json({
      members: (world.profiles.CommunityProfile ?? []).map((p: ObjectPayload) => ({
        aid: p.data.userAID, name: nameOf(p.data.userAID as string), role: p.data.role, joinedAt: p.data.memberSince,
      })),
    })],
    ['GET', /^\/api\/v1\/role-policy$/, ({ world, me }) => {
      const { callerCapabilitiesByRole, ...rest } = POLICY;
      return json({ ...rest, policy: dash(world).policy, callerCapabilities: callerCapabilitiesByRole[byAid(me)?.role ?? ''] ?? [] });
    }],
    ['PUT', /^\/api\/v1\/role-policy$/, (r) => {
      const d = dash(r.world);
      const u = body<{ version: number; roles: unknown[]; grants: Record<string, string[]> }>(r);
      if (u.version !== d.policy.version) return json({ error: 'conflict', currentVersion: d.policy.version }, 409);
      d.policy = { ...d.policy, ...u, version: u.version + 1, updatedBy: r.me ?? '', updatedAt: now() };
      return json({ policy: d.policy });
    }],
    ['GET', /^\/api\/v1\/community-settings\/access$/, ({ me }) =>
      isSteward(me) ? json({ ok: true }) : json({ error: 'insufficient permissions' }, 403)],
    ['GET', /^\/api\/v1\/comment-cursors$/, ({ world, me }) => json({ cursors: dash(world).commentCursors[me ?? ''] ?? {} })],
    ['PUT', /^\/api\/v1\/comment-cursors$/, (r) => {
      const { key, count } = body<{ key: string; count: number }>(r);
      const mine = (dash(r.world).commentCursors[r.me ?? ''] ??= {});
      mine[key] = count;
      return json({ cursors: mine });
    }],
    // The backend half of approving a registration: flip the applicant's SharedProfile.
    ['POST', /^\/api\/v1\/profiles\/init-member$/, (r) => {
      const b = body<{ memberAid?: string; role?: string }>(r);
      approve(r.world, b.memberAid ?? '', b.role);
      return ok();
    }],
    // Approval asks for space invites before issuing the credential; the keys go nowhere.
    ['POST', /^\/api\/v1\/spaces\/community\/invite$/, () => ok({
      communitySpaceId: ORG.communitySpaceId, inviteKey: 'harness-invite-key',
      readOnlySpaceId: ORG.readOnlySpaceId, readOnlyInviteKey: 'harness-readonly-invite-key',
    })],
    // Push is dark here, as on any backend with no relay configured (usePush latches on the 404).
    ['GET', /^\/api\/v1\/push\/relay-challenge$/, () => json({ error: 'push not configured' }, 404)],
  ];

  const chat: Route[] = [
    // Stewards-only channels are filtered server-side, as the Go handler does.
    ['GET', /^\/api\/v1\/chat\/channels$/, ({ world, me, query }) => json({
      channels: dash(world).channels.filter((c) =>
        (!c.allowedRoles?.length || isSteward(me)) && (query.get('includeArchived') === 'true' || !c.isArchived)),
    })],
    ['POST', /^\/api\/v1\/chat\/channels$/, (r) => {
      const id = nextId('ch');
      dash(r.world).channels.push({ ...body<Rec>(r), id, createdAt: now(), createdBy: r.me ?? '', isArchived: false });
      return ok({ channelId: id });
    }],
    ['GET', /^\/api\/v1\/chat\/channels\/([^/]+)$/, (r, m) => found(channel(r, m))],
    ['PUT', /^\/api\/v1\/chat\/channels\/([^/]+)$/, (r, m) => {
      const ch = channel(r, m);
      if (!ch) return notFound();
      Object.assign(ch, body<Rec>(r));
      return ok();
    }],
    ['DELETE', /^\/api\/v1\/chat\/channels\/([^/]+)$/, (r, m) => {
      const ch = channel(r, m);
      if (ch) ch.isArchived = true;
      return ok();
    }],
    // Newest first, thread replies inline — the Go handler's order.
    ['GET', /^\/api\/v1\/chat\/channels\/([^/]+)\/messages$/, ({ world, me }, m) => {
      const list = dash(world).messages.filter((x) => x.channelId === decodeURIComponent(m[1]!))
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt)).map((x) => messageView(x, me));
      return json({ messages: list, count: list.length, nextCursor: '', hasMore: false });
    }],
    ['POST', /^\/api\/v1\/chat\/channels\/([^/]+)\/messages$/, (r, m) => {
      const b = body<{ content: string; replyTo?: string; attachments?: unknown[] }>(r);
      const msg: Msg = {
        id: nextId('msg'), channelId: decodeURIComponent(m[1]!), senderAid: r.me ?? '', senderName: nameOf(r.me),
        content: b.content, sentAt: now(), reactions: {}, version: 1,
        ...(b.replyTo ? { replyTo: b.replyTo } : {}), ...(b.attachments?.length ? { attachments: b.attachments } : {}),
      };
      dash(r.world).messages.push(msg);
      return ok({ messageId: msg.id, sentAt: msg.sentAt });
    }],
    ['PUT', /^\/api\/v1\/chat\/messages\/([^/]+)$/, (r, m) => {
      const msg = message(r, m);
      if (!msg) return notFound();
      Object.assign(msg, { content: body<{ content: string }>(r).content, editedAt: now(), version: msg.version + 1 });
      return ok({ editedAt: msg.editedAt });
    }],
    ['DELETE', /^\/api\/v1\/chat\/messages\/([^/]+)$/, (r, m) => {
      const msg = message(r, m);
      if (msg) msg.deletedAt = now();
      return ok();
    }],
    ['GET', /^\/api\/v1\/chat\/messages\/([^/]+)\/thread$/, ({ world, me }, m) => {
      const id = decodeURIComponent(m[1]!);
      const replies = dash(world).messages.filter((x) => x.replyTo === id)
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt)).map((x) => messageView(x, me));
      return json({ parentMessageId: id, replies, count: replies.length });
    }],
    ['POST', /^\/api\/v1\/chat\/messages\/([^/]+)\/reactions$/, (r, m) => {
      const msg = message(r, m);
      if (!msg || !r.me) return notFound();
      const who = (msg.reactions[body<{ emoji: string }>(r).emoji] ??= []);
      if (!who.includes(r.me)) who.push(r.me);
      return ok({ count: who.length });
    }],
    ['DELETE', /^\/api\/v1\/chat\/messages\/([^/]+)\/reactions\/([^/]+)$/, (r, m) => {
      const msg = message(r, m);
      if (!msg) return notFound();
      const emoji = decodeURIComponent(m[2]!);
      const who = (msg.reactions[emoji] = (msg.reactions[emoji] ?? []).filter((a) => a !== r.me));
      return ok({ count: who.length });
    }],
    ['GET', /^\/api\/v1\/chat\/read-cursors$/, ({ world, me }) => json({ cursors: dash(world).readCursors[me ?? ''] ?? {} })],
    ['PUT', /^\/api\/v1\/chat\/read-cursors$/, (r) => {
      const { channelId, lastReadAt } = body<{ channelId: string; lastReadAt: string }>(r);
      (dash(r.world).readCursors[r.me ?? ''] ??= {})[channelId] = lastReadAt;
      return ok();
    }],
  ];

  const notices: Route[] = [
    ['GET', /^\/api\/v1\/notices$/, ({ world, query }) => {
      const type = query.get('type');
      return json({ notices: dash(world).notices.filter((n) => !type || n.type === type) });
    }],
    ['POST', /^\/api\/v1\/notices$/, (r) => {
      const b = body<Rec>(r);
      const id = nextId('notice');
      const published = b.state === 'published';
      dash(r.world).notices.push({
        ...b, id, type: String(b.type ?? 'update'), state: published ? 'published' : 'draft', pinned: false,
        issuerType: 'person', issuerId: r.me ?? '', issuerDisplayName: nameOf(r.me), createdAt: now(), createdBy: r.me ?? '',
        ...(published ? { publishedAt: now(), publishAt: now() } : {}),
      });
      return ok({ noticeId: id });
    }],
    ['GET', /^\/api\/v1\/notices\/saved$/, ({ world, me }) => json({
      saves: Object.entries(dash(world).saves[me ?? ''] ?? {}).map(([noticeId, savedAt]) => ({ noticeId, userId: me, savedAt, pinned: true })),
    })],
    ['GET', /^\/api\/v1\/notices\/([^/]+)$/, (r, m) => withNotice(r, m, (_d, n) => json(n))],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/publish$/, (r, m) => withNotice(r, m, (_d, n) => {
      Object.assign(n, { state: 'published', publishedAt: now(), publishAt: now() });
      return ok();
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/archive$/, (r, m) => withNotice(r, m, (_d, n) => {
      Object.assign(n, { state: 'archived', archivedAt: now() });
      return ok();
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/pin$/, (r, m) => withNotice(r, m, (_d, n) => { n.pinned = !n.pinned; return ok(); })],
    ['GET', /^\/api\/v1\/notices\/([^/]+)\/rsvp$/, (r, m) => withNotice(r, m, (d, n) => {
      const entries = Object.entries(d.rsvps[n.id] ?? {});
      const counts: Record<string, number> = { going: 0, maybe: 0, not_going: 0 };
      for (const [, x] of entries) counts[x.status] = (counts[x.status] ?? 0) + 1;
      return json({ rsvps: entries.map(([userId, x]) => ({ id: `${n.id}-${userId}`, noticeId: n.id, userId, ...x })), counts });
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/rsvp$/, (r, m) => withNotice(r, m, (d, n) => {
      (d.rsvps[n.id] ??= {})[r.me ?? ''] = { status: body<{ status: string }>(r).status, updatedAt: now() };
      return ok();
    })],
    ['GET', /^\/api\/v1\/notices\/([^/]+)\/ack$/, (r, m) => withNotice(r, m, (d, n) => {
      const acks = Object.entries(d.acks[n.id] ?? {}).map(([userId, ackAt]) => ({ id: `${n.id}-${userId}`, noticeId: n.id, userId, ackAt, method: 'app' }));
      return json({ acks, count: acks.length });
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/ack$/, (r, m) => withNotice(r, m, (d, n) => {
      (d.acks[n.id] ??= {})[r.me ?? ''] = now();
      return ok();
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/save$/, (r, m) => withNotice(r, m, (d, n) => {
      const mine = (d.saves[r.me ?? ''] ??= {});
      const pinned = !mine[n.id];
      if (pinned) mine[n.id] = now();
      else delete mine[n.id];
      return ok({ pinned });
    })],
    ['GET', /^\/api\/v1\/notices\/([^/]+)\/comments$/, (r, m) => withNotice(r, m, (d, n) => {
      const comments = d.comments[n.id] ?? [];
      return json({ comments, count: comments.length });
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/comments$/, (r, m) => withNotice(r, m, (d, n) => {
      (d.comments[n.id] ??= []).push({
        id: nextId('comment'), noticeId: n.id, userId: r.me ?? '', userDisplayName: nameOf(r.me), text: body<{ text: string }>(r).text, createdAt: now(),
      });
      return ok();
    })],
    ['GET', /^\/api\/v1\/notices\/([^/]+)\/reactions$/, (r, m) => withNotice(r, m, (d, n) => {
      const active = (d.reactions[n.id] ?? []).filter((x) => x.active);
      const counts: Record<string, number> = {};
      for (const x of active) counts[x.emoji] = (counts[x.emoji] ?? 0) + 1;
      return json({ reactions: active, counts });
    })],
    ['POST', /^\/api\/v1\/notices\/([^/]+)\/reactions$/, (r, m) => withNotice(r, m, (d, n) => {
      const emoji = body<{ emoji: string }>(r).emoji;
      const list = (d.reactions[n.id] ??= []);
      const mine = list.find((x) => x.userId === r.me && x.emoji === emoji);
      if (mine) mine.active = !mine.active;
      else list.push({ id: nextId('reaction'), noticeId: n.id, userId: r.me ?? '', emoji, active: true, createdAt: now() });
      return ok();
    })],
  ];

  // Read-only: enough for the lists and detail pages to render; transitions fall
  // through to the plugin's `{ success: true }`.
  const work: Route[] = [
    ['GET', /^\/api\/v1\/projects$/, ({ world, query }) => {
      const proposal = query.get('proposal_id');
      const projects = dash(world).projects.filter((p) => !proposal || p.proposal_ids.includes(proposal));
      return json({ projects, total: projects.length });
    }],
    ['GET', /^\/api\/v1\/projects\/([^/]+)$/, ({ world }, m) => found(dash(world).projects.find((p) => p.id === m[1]))],
    ['GET', /^\/api\/v1\/projects\/([^/]+)\/contributions$/, ({ world }, m) => {
      const contributions = dash(world).contributions.filter((c) => c.project_id === m[1]);
      return json({ contributions, total: contributions.length });
    }],
    ['GET', /^\/api\/v1\/projects\/([^/]+)\/comments$/, noComments],
    ['GET', /^\/api\/v1\/contributions$/, ({ world, query }) => {
      const project = query.get('project_id');
      const status = query.get('status');
      const contributions = dash(world).contributions.filter((c) => (!project || c.project_id === project) && (!status || c.status === status));
      return json({ contributions, total: contributions.length });
    }],
    ['GET', /^\/api\/v1\/contributions\/([^/]+)$/, ({ world }, m) => found(dash(world).contributions.find((c) => c.id === m[1]))],
    ['GET', /^\/api\/v1\/contributions\/([^/]+)\/comments$/, noComments],
    ['GET', /^\/api\/v1\/contributions\/([^/]+)\/registrations$/, () => json({ registrations: [], total: 0 })],
    ['GET', /^\/api\/v1\/proposals$/, ({ world }) => json({ proposals: dash(world).proposals, total: dash(world).proposals.length })],
    ['GET', /^\/api\/v1\/proposals\/([^/]+)$/, ({ world }, m) => found(dash(world).proposals.find((p) => p.id === m[1]))],
    ['GET', /^\/api\/v1\/proposals\/([^/]+)\/endorsements$/, (_r, m) => json(m[1] === 'prp-garden'
      ? { endorsements: [{ endorser_id: aidOf('aroha'), endorsed_at: new Date(Date.now() - 86400_000).toISOString(), comment: 'Tautoko — the tamariki will love it.' }], total: 1 }
      : { endorsements: [], total: 0 })],
    ['GET', /^\/api\/v1\/proposals\/([^/]+)\/comments$/, noComments],
    ['GET', /^\/api\/v1\/proposals\/([^/]+)\/history$/, () => json({ history: [], total: 0 })],
    ['GET', /^\/api\/v1\/implementation-plans$/, () => json({ implementation_plans: [], total: 0 })],
    ['GET', /^\/api\/v1\/decision-plans$/, () => json({ decision_plans: [], total: 0 })],
  ];

  return [...community, ...chat, ...notices, ...work];
}
