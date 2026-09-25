/**
 * What the community has been up to before the scenario opens: chat, notices
 * and a little project work. Plain data, keyed by the people in
 * `scenarios.ts`; times are offsets from when the world is built, so the chat
 * reads "40 min ago" and the events stay upcoming whichever day the harness runs.
 * `backendRoutes.ts` copies this into each world on first use and answers from
 * the copy, so posting, reacting and RSVPing stick until the scenario resets.
 */
import type { PersonId } from '../scenarios';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ago = { min: (n: number) => -n * MIN, hr: (n: number) => -n * HOUR, day: (n: number) => -n * DAY };
export const ahead = { hr: (n: number) => n * HOUR, day: (n: number) => n * DAY };

// --- chat

export interface SeedChannel {
  id: string;
  name: string;
  description: string;
  icon: string;
  by: PersonId;
  createdAt: number;
  /** Stewards-only channels; the backend hides them from everyone else. */
  allowedRoles?: string[];
}

export interface SeedMessage {
  id: string;
  channel: string;
  from: PersonId;
  at: number;
  text: string;
  replyTo?: string;
  reactions?: Record<string, PersonId[]>;
}

export const CHANNELS: SeedChannel[] = [
  { id: 'ch-general', name: 'general', description: 'Kōrero for the whole whānau', icon: '💬', by: 'aroha', createdAt: ago.day(120) },
  { id: 'ch-kapa-haka', name: 'kapa-haka', description: 'Practice times, waiata and uniforms', icon: '🎶', by: 'tama', createdAt: ago.day(58) },
  { id: 'ch-kai', name: 'kai', description: 'Friday kai roster, recipes, who is bringing what', icon: '🍠', by: 'tama', createdAt: ago.day(40) },
  { id: 'ch-stewards', name: 'stewards', description: 'Stewards only — approvals and planning', icon: '🛡️', by: 'aroha', createdAt: ago.day(119), allowedRoles: ['admin', 'steward'] },
];

export const MESSAGES: SeedMessage[] = [
  // #general
  { id: 'm-gen-1', channel: 'ch-general', from: 'aroha', at: ago.day(3), text: 'Mōrena koutou! Welcome to everyone who joined this month 🌿', reactions: { '❤️': ['tama', 'mere'] } },
  { id: 'm-gen-2', channel: 'ch-general', from: 'mere', at: ago.day(3) + 20 * MIN, text: 'Mōrena! Glad to be here. The whakapapa records are up to date as of last night.' },
  { id: 'm-gen-3', channel: 'ch-general', from: 'tama', at: ago.day(2), text: 'Reminder: hui at the marae this Saturday, 10am. Bring a plate if you can.', reactions: { '👍': ['aroha', 'mere'] } },
  { id: 'm-gen-4', channel: 'ch-general', from: 'aroha', at: ago.day(2) + 30 * MIN, text: 'Ka pai Tama. I will open up from 9.', replyTo: 'm-gen-3' },
  { id: 'm-gen-5', channel: 'ch-general', from: 'mere', at: ago.day(1), text: 'Does anyone have a spare trestle table? The hall ones are booked.' },
  { id: 'm-gen-6', channel: 'ch-general', from: 'tama', at: ago.day(1) + 15 * MIN, text: 'I have two in the shed, I will drop them round.', replyTo: 'm-gen-5', reactions: { '🙏': ['mere'] } },
  { id: 'm-gen-7', channel: 'ch-general', from: 'aroha', at: ago.hr(5), text: 'Photos from last weekend are in the shared drive — beautiful day, ngā mihi to everyone who helped.', reactions: { '😍': ['mere'] } },
  { id: 'm-gen-8', channel: 'ch-general', from: 'mere', at: ago.hr(2), text: 'Just read the new notice about the reo classes — keen!' },
  { id: 'm-gen-9', channel: 'ch-general', from: 'aroha', at: ago.min(40), text: 'Two new whānau have applied to join. I will look at them tonight.' },

  // #kapa-haka
  { id: 'm-kh-1', channel: 'ch-kapa-haka', from: 'tama', at: ago.day(4), text: 'Practice moves to Wednesdays 6pm from next week, same hall.' },
  { id: 'm-kh-2', channel: 'ch-kapa-haka', from: 'mere', at: ago.day(4) + 45 * MIN, text: 'Works for me. Can we run the new waiata first while everyone is fresh?', reactions: { '👍': ['tama'] } },
  { id: 'm-kh-3', channel: 'ch-kapa-haka', from: 'aroha', at: ago.day(3), text: 'Kuia Hinewai has offered to come and help with the actions 🙌', reactions: { '🔥': ['tama', 'mere'] } },
  { id: 'm-kh-4', channel: 'ch-kapa-haka', from: 'tama', at: ago.day(2), text: 'Uniform order closes Friday. Sizes to me please.' },
  { id: 'm-kh-5', channel: 'ch-kapa-haka', from: 'mere', at: ago.day(2) + 10 * MIN, text: 'Medium for me, and a small for my niece.', replyTo: 'm-kh-4' },
  { id: 'm-kh-6', channel: 'ch-kapa-haka', from: 'aroha', at: ago.day(1), text: 'Large please. And can we get a couple of spares for the rangatahi?', replyTo: 'm-kh-4' },
  { id: 'm-kh-7', channel: 'ch-kapa-haka', from: 'tama', at: ago.hr(3), text: 'Recording of last practice is up — the harmonies are sounding mean 🎶', reactions: { '❤️': ['aroha', 'mere'] } },

  // #kai
  { id: 'm-kai-1', channel: 'ch-kai', from: 'tama', at: ago.day(6), text: 'Friday kai roster for October is pinned in Activity. Swap freely, just say here.' },
  { id: 'm-kai-2', channel: 'ch-kai', from: 'mere', at: ago.day(5), text: 'I will do the boil-up on the 3rd. Anyone got a big pot?' },
  { id: 'm-kai-3', channel: 'ch-kai', from: 'aroha', at: ago.day(5) + 30 * MIN, text: 'The marae has two, I will leave one out.', replyTo: 'm-kai-2' },
  { id: 'm-kai-4', channel: 'ch-kai', from: 'tama', at: ago.day(2), text: 'Rēwena bread recipe from Nan, as promised 🍞 Starter needs 3 days.', reactions: { '😋': ['aroha', 'mere'], '🙏': ['aroha'] } },
  { id: 'm-kai-5', channel: 'ch-kai', from: 'mere', at: ago.day(1), text: 'Mine came out flat… I think my kitchen is too cold.', replyTo: 'm-kai-4' },
  { id: 'm-kai-6', channel: 'ch-kai', from: 'tama', at: ago.day(1) + 20 * MIN, text: 'Hot water cupboard trick! Leave it in there overnight.', replyTo: 'm-kai-5', reactions: { '😂': ['mere'] } },
  { id: 'm-kai-7', channel: 'ch-kai', from: 'aroha', at: ago.hr(1), text: 'Hāngī for the open day — who can help dig on Friday arvo?' },

  // #stewards
  { id: 'm-st-1', channel: 'ch-stewards', from: 'aroha', at: ago.day(2), text: 'Wiremu Pōtae has applied — works in tech in Rotorua, keen to help with the app.' },
  { id: 'm-st-2', channel: 'ch-stewards', from: 'aroha', at: ago.day(1), text: 'Hine Kāwhia applied too; she ran events for her iwi rūnanga. Good fit for the open day.' },
  { id: 'm-st-3', channel: 'ch-stewards', from: 'aroha', at: ago.hr(6), text: 'Note to self: set up the reo class notice with ack so we know numbers.' },
];

/** When each person last read each channel; later messages count as unread. */
export const READ_CURSORS: Partial<Record<PersonId, Record<string, number>>> = {
  tama: { 'ch-general': ago.hr(6), 'ch-kapa-haka': ago.hr(3), 'ch-kai': ago.day(1) },
  aroha: { 'ch-general': ago.min(40), 'ch-kapa-haka': ago.day(2), 'ch-kai': ago.hr(1), 'ch-stewards': ago.hr(6) },
};

// --- notices (Activity)

export interface SeedNotice {
  id: string;
  type: 'event' | 'update' | 'announcement';
  title: string;
  summary: string;
  body: string;
  by: PersonId;
  at: number;
  pinned?: boolean;
  ackRequired?: boolean;
  ackDueIn?: number;
  event?: { start: number; hours: number; where: string; url?: string; capacity?: number };
  rsvps?: Partial<Record<PersonId, 'going' | 'maybe' | 'not_going'>>;
  acks?: PersonId[];
  comments?: Array<{ from: PersonId; at: number; text: string }>;
  reactions?: Record<string, PersonId[]>;
}

export const NOTICES: SeedNotice[] = [
  {
    id: 'n-welcome', type: 'announcement', pinned: true, by: 'aroha', at: ago.day(20),
    title: 'Nau mai, haere mai — start here',
    summary: 'How we look after each other in this space, and where to find things.',
    body: 'Kia ora koutou. This app is our shared whare: chat for everyday kōrero, Activity for notices and events, Projects for the mahi. Be kind, assume good intent, and ask a steward if you are unsure.',
    reactions: { '❤️': ['tama', 'mere'], '🙏': ['mere'] },
  },
  {
    id: 'n-reo', type: 'announcement', ackRequired: true, ackDueIn: ahead.day(7), by: 'aroha', at: ago.day(1),
    title: 'Te reo classes start in October',
    summary: 'Eight Tuesday evenings at the marae. Please acknowledge so we can plan numbers.',
    body: 'Beginners and returners welcome. Whaea Rangi will teach; koha only. Tap Acknowledge so we know you have seen this.',
    acks: ['mere'],
    comments: [
      { from: 'mere', at: ago.hr(20), text: 'Can tamariki come along too?' },
      { from: 'aroha', at: ago.hr(19), text: 'Āe, from 10 years up.' },
    ],
  },
  {
    id: 'n-roster', type: 'update', by: 'tama', at: ago.day(6),
    title: 'Friday kai roster — October',
    summary: 'Mere 3rd, Tama 10th, Aroha 17th, open day hāngī on the 24th.',
    body: 'Swap in #kai if a week does not suit. Dietary notes go on the kitchen whiteboard.',
    reactions: { '😋': ['aroha', 'mere'] },
  },
  {
    id: 'n-hui', type: 'event', by: 'aroha', at: ago.day(4),
    title: 'Whānau hui',
    summary: 'Quarterly hui: projects update, open day planning, and kai after.',
    body: 'Agenda: 1. Karakia and mihi 2. Projects update 3. Open day planning 4. General business. Bring a plate.',
    event: { start: ahead.day(1) + ahead.hr(1), hours: 3, where: 'Ōmarumutu Marae, Ōpōtiki' },
    rsvps: { aroha: 'going', mere: 'going' },
    comments: [{ from: 'mere', at: ago.day(2), text: 'I can bring the projector.' }],
  },
  {
    id: 'n-openday', type: 'event', by: 'tama', at: ago.day(3),
    title: 'Community open day',
    summary: 'Hāngī, kapa haka and stalls. Everyone welcome — bring friends.',
    body: 'Set-up from 8am. Kapa haka performs at 12. We need helpers for the hāngī pit on Friday afternoon.',
    event: { start: ahead.day(29), hours: 6, where: 'Memorial Park, Ōpōtiki', capacity: 150 },
    rsvps: { aroha: 'going', tama: 'going', mere: 'maybe' },
    reactions: { '🔥': ['aroha', 'mere'] },
  },
  {
    id: 'n-zoom', type: 'event', by: 'mere', at: ago.day(2),
    title: 'Whakapapa research drop-in (online)',
    summary: 'Bring your questions about tracing whānau lines. Informal, cameras optional.',
    body: 'I will share how the records are organised and how to request a copy.',
    event: { start: ahead.day(6) + ahead.hr(-2), hours: 1, where: 'Online', url: 'https://meet.example.nz/whakapapa' },
    rsvps: { tama: 'maybe' },
  },
];

/** Notices each person has saved. */
export const SAVED: Partial<Record<PersonId, string[]>> = { tama: ['n-openday'], aroha: ['n-reo'] };

// --- projects

export const PROJECTS = [
  {
    id: 'prj-openday', title: 'Community open day 2026', status: 'active',
    description: 'Plan and run the October open day: hāngī, kapa haka performance, stalls and signage.',
    steward: 'aroha', lead: 'tama', budget: '$2,400', duration: '6 weeks', start: ago.day(14), end: ahead.day(29), at: ago.day(20),
  },
  {
    id: 'prj-archive', title: 'Whakapapa digital archive', status: 'created',
    description: 'Scan and index the whānau records so members can request copies securely.',
    steward: 'aroha', lead: 'mere', budget: '$1,200', duration: '3 months', at: ago.day(9),
  },
] as const;

export const CONTRIBUTIONS = [
  {
    id: 'ctb-signage', project: 'prj-openday', title: 'Bilingual signage for the open day', type: 'art_design', priority: 'medium',
    status: 'assigned', assignee: 'tama', by: 'aroha', at: ago.day(12), deadline: ahead.day(20),
    description: 'Six A1 signs in te reo and English: welcome, kai, toilets, stage, first aid, lost tamariki.',
    deliverables: ['Print-ready PDFs', 'Te reo checked by a kaumātua'],
  },
  {
    id: 'ctb-hangi', project: 'prj-openday', title: 'Hāngī crew coordination', type: 'coordination_operations', priority: 'high',
    status: 'shared', by: 'tama', at: ago.day(8), deadline: ahead.day(27),
    description: 'Line up the pit crew, wood and baskets; run the lift on the day.',
    deliverables: ['Crew roster', 'Supplies list'],
  },
  {
    id: 'ctb-scan', project: 'prj-archive', title: 'Scan the 1950s minute books', type: 'research_knowledge', priority: 'low',
    status: 'created', by: 'mere', at: ago.day(5),
    description: 'Borrow the scanner from the library and digitise the three minute books.',
    deliverables: ['PDF scans', 'Index spreadsheet'],
  },
] as const;

export const PROPOSALS = [
  {
    id: 'prp-garden', title: 'Māra kai at the marae', by: 'mere', status: 'submitted', priority: 'medium', at: ago.day(3),
    type: ['coordination_operations'],
    description: 'Start a community vegetable garden behind the wharekai.',
    problem: 'Kai costs keep rising and the tamariki have nowhere to learn growing.',
    solution: 'Four raised beds, a roster, and a working bee each season.',
    outcomes: ['Fresh kai for Friday dinners', 'A learning space for tamariki'],
    budget: '$800', timeline: '3 months',
  },
] as const;
