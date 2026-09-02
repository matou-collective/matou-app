#!/usr/bin/env node
/**
 * Seed the store-screenshot community with believable content.
 *
 * Reads ../cast.json and drives the backend API directly. Run AFTER the
 * bootstrap spec has created the org and approved the member:
 *
 *   node docs/mobile/store-listing/scripts/seed-store-data.mjs
 *
 * Admin backend :9080 acts as the steward; the member's own backend :9280
 * posts the member's chat lines so the conversation is genuinely two-sided.
 * Nothing here touches production — both backends are MATOU_ENV=test.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'cast.json'), 'utf-8'));

const ADMIN = process.env.ADMIN_API ?? 'http://localhost:9080/api/v1';
const MEMBER = process.env.MEMBER_API ?? 'http://localhost:9280/api/v1';
const TOKEN = process.env.MATOU_API_TOKEN ?? 'matou-dev';

async function api(base, aid, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User-AID': aid,
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : undefined;
}

async function identityOf(base, label) {
  const res = await fetch(`${base}/identity`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  if (!body?.aid) throw new Error(`${label} backend has no identity yet: ${JSON.stringify(body)}`);
  return body.aid;
}

/** Date helper: an ISO timestamp N days from now, at a civilised hour. */
function daysOut(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const main = async () => {
  const steward = await identityOf(ADMIN, 'admin');
  const member = await identityOf(MEMBER, 'member');
  console.log(`steward ${steward.slice(0, 12)}…  member ${member.slice(0, 12)}…`);

  const who = { steward: [ADMIN, steward], member: [MEMBER, member] };

  // --- Chat channels -----------------------------------------------------
  const existing = await api(ADMIN, steward, 'GET', '/chat/channels');
  const byName = new Map((existing.channels ?? []).map((c) => [c.name, c]));

  const channels = {};
  for (const ch of CAST.channels) {
    if (byName.has(ch.name)) {
      channels[ch.name] = byName.get(ch.name);
      console.log(`channel ${ch.name} (existing)`);
      continue;
    }
    channels[ch.name] = await api(ADMIN, steward, 'POST', '/chat/channels', {
      name: ch.name,
      description: ch.description,
    });
    console.log(`channel ${ch.name} created`);
  }

  // --- The conversation --------------------------------------------------
  const target = channels[CAST.conversation.channel];
  const channelId = target.id ?? target.channelId;
  const priorMsgs = await api(ADMIN, steward, 'GET', `/chat/channels/${channelId}/messages`)
    .catch(() => ({}));
  const priorTexts = new Set((priorMsgs.messages ?? []).map((m) => m.content));
  for (const msg of CAST.conversation.messages) {
    if (priorTexts.has(msg.text)) {
      console.log(`  ${msg.from}: (already posted)`);
      continue;
    }
    const [base, aid] = who[msg.from];
    await api(base, aid, 'POST', `/chat/channels/${channelId}/messages`, { content: msg.text });
    console.log(`  ${msg.from}: ${msg.text.slice(0, 48)}…`);
    // Ordering is by server receipt; a beat keeps the transcript in sequence
    // and lets the member's line replicate before the next steward reply.
    await new Promise((r) => setTimeout(r, 1200));
  }

  // --- Project, plan, milestones, contributions --------------------------
  const projectList = await api(ADMIN, steward, 'GET', '/projects');
  let project = (projectList.projects ?? []).find((p) => p.title === CAST.project.name);
  if (project) {
    console.log(`project ${CAST.project.name} (existing) -> ${project.id}`);
  } else {
    project = await api(ADMIN, steward, 'POST', '/projects', {
      title: CAST.project.name,
      description: CAST.project.description,
      created_by: steward,
    });
    console.log(`project ${CAST.project.name} -> ${project.id}`);
  }

  // Lead role makes the project's edit affordances visible to the steward.
  await api(ADMIN, steward, 'POST', `/projects/${project.id}/assign-role`, {
    role: 'lead',
    user_id: steward,
  }).catch((e) => console.log(`  (assign-role skipped: ${e.message.slice(0, 80)})`));

  const existingPlans = await api(ADMIN, steward, 'GET', '/implementation-plans').catch(() => ({}));
  let plan = (existingPlans.plans ?? existingPlans.implementation_plans ?? []).find(
    (pl) => pl.project_id === project.id,
  );
  if (plan) {
    console.log('  plan (existing)');
  } else {
    plan = await api(ADMIN, steward, 'POST', '/implementation-plans', {
      project_id: project.id,
      title: CAST.project.plan.title,
      total_budget: '0',
      project_lead: steward,
      project_steward_id: steward,
    });
  }

  const planNow = await api(ADMIN, steward, 'GET', `/implementation-plans/${plan.id}`).catch(() => plan);
  const alreadyHas = new Set(
    ((planNow.milestones ?? planNow.Milestones ?? [])).map((m) => m.title),
  );

  const milestoneIds = [];
  for (const [i, ms] of CAST.project.plan.milestones.entries()) {
    if (alreadyHas.has(ms.title)) {
      const list = planNow.milestones ?? planNow.Milestones ?? [];
      const found = list.find((m) => m.title === ms.title);
      milestoneIds.push(found?.milestone_id ?? found?.id);
      console.log(`  milestone ${ms.title} (existing)`);
      continue;
    }
    const after = await api(ADMIN, steward, 'POST', `/implementation-plans/${plan.id}/milestones`, {
      title: ms.title,
      description: ms.description,
      duration: `${2 + i} weeks`,
    });
    const list = after.milestones ?? after.Milestones ?? [];
    const last = list[list.length - 1];
    milestoneIds.push(last?.milestone_id ?? last?.id);
    console.log(`  milestone ${ms.title}`);
  }

  const existingContribs = await api(ADMIN, steward, 'GET', '/contributions').catch(() => ({}));
  const contribTitles = new Set(
    (existingContribs.contributions ?? [])
      .filter((c) => c.project_id === project.id)
      .map((c) => c.title),
  );
  for (const [i, c] of CAST.project.contributions.entries()) {
    if (contribTitles.has(c.title)) {
      console.log(`  contribution ${c.title} (existing)`);
      continue;
    }
    await api(ADMIN, steward, 'POST', '/contributions', {
      project_id: project.id,
      milestone_id: milestoneIds[i] ?? milestoneIds[0],
      title: c.title,
      description: c.objective,
      contribution_type: 'task',
      priority: 'medium',
      created_by: steward,
      objectives: [c.objective],
      deliverables: [c.deliverable],
      acceptance_criteria: [c.acceptance],
    });
    console.log(`  contribution ${c.title}`);
  }

  // A contribution needs a due date before it can be confirmed, and a plan
  // that reads "0/3 confirmed" looks half-finished in a store screenshot.
  const allContribs = await api(ADMIN, steward, 'GET', '/contributions').catch(() => ({}));
  const ours = (allContribs.contributions ?? []).filter((c) => c.project_id === project.id);
  for (const [i, c] of ours.entries()) {
    if (c.status !== 'created') continue;
    const due = new Date();
    due.setDate(due.getDate() + (i + 1) * 21);
    await api(ADMIN, steward, 'PUT', `/contributions/${c.id}`, { deadline: due.toISOString() });
    await api(ADMIN, steward, 'POST', `/contributions/${c.id}/confirm`, {});
    console.log(`  confirmed ${c.title}`);
  }

  // --- Proposal ----------------------------------------------------------
  const proposalList = await api(ADMIN, steward, 'GET', '/proposals').catch(() => ({}));
  const already = (proposalList.proposals ?? []).find((p) => p.title === CAST.proposal.title);
  const proposal = already ?? await api(ADMIN, steward, 'POST', '/proposals', {
    proposer_id: steward,
    title: CAST.proposal.title,
    type: ['governance'],
    priority: 'medium',
    description: CAST.proposal.summary,
    problem_statement:
      'The same few people end up maintaining the garden and the grounds, which is not sustainable.',
    solution:
      'A standing monthly working bee, rostered across whānau, published a month ahead.',
    expected_outcomes: [
      'Maintenance shared fairly across the collective',
      'A published roster everyone can plan around',
    ],
    estimated_budget: '$0',
    timeline: 'Ongoing, reviewed annually',
  });
  console.log(`proposal ${CAST.proposal.title} -> ${proposal.id ?? '(created)'}`);

  const proposalId = proposal.id ?? proposal.proposal?.id;
  if (proposalId) {
    await api(MEMBER, member, 'POST', `/proposals/${proposalId}/endorse`, {
      endorser_id: member,
      comment: 'Strongly support — this spreads the load properly.',
    }).catch((e) => console.log(`  (endorse skipped: ${e.message.slice(0, 80)})`));
  }

  // The Proposals page defaults to the Active filter (submitted / in_review /
  // signed_off / voting_process); a draft proposal renders as "No proposals
  // yet". voting_process needs a proposal lead, so in_review is as far as an
  // unattended seed can walk it.
  if (proposalId) {
    for (const status of ['submitted', 'in_review']) {
      await api(ADMIN, steward, 'POST', `/proposals/${proposalId}/transition`, { status })
        .then(() => console.log(`  proposal -> ${status}`))
        .catch((e) => console.log(`  (transition ${status} skipped: ${e.message.slice(0, 70)})`));
    }
  }

  // --- Notices -----------------------------------------------------------
  const noticeList = await api(ADMIN, steward, 'GET', '/notices').catch(() => ({}));
  const noticeTitles = new Set((noticeList.notices ?? []).map((n) => n.title));
  for (const [i, n] of CAST.notices.entries()) {
    if (noticeTitles.has(n.title)) {
      console.log(`notice ${n.title} (existing)`);
      continue;
    }
    const notice = await api(ADMIN, steward, 'POST', '/notices', {
      type: n.type,
      title: n.title,
      summary: n.summary,
      state: 'published',
      ...(n.type === 'event'
        ? {
            eventStart: daysOut(4 + i, 10),
            eventEnd: daysOut(4 + i, 13),
            locationMode: 'in_person',
            locationText: 'Te Whare Tapere, marae grounds',
            rsvpEnabled: true,
          }
        : {}),
    });
    // state:"published" is honoured by the handler, but older builds default
    // to draft — publish explicitly when the response still says draft.
    const id = notice?.id ?? notice?.notice?.id;
    if (id && (notice.state ?? notice.notice?.state) === 'draft') {
      await api(ADMIN, steward, 'POST', `/notices/${id}/publish`, {}).catch(() => {});
    }
    console.log(`notice ${n.title}`);
  }

  console.log('\nSeeded. Give any-sync a minute to replicate to the member backend.');
};

main().catch((e) => {
  console.error(`\nSEED FAILED: ${e.message}`);
  process.exit(1);
});
