/**
 * Typeahead search backing the chat @-mention composer (issues #12, #37).
 *
 * All six mentionable entity types are already synced client-side, so the
 * search reads local Pinia stores — no new backend API. #12 wired the `person`
 * type (community profiles); #37 adds project / proposal / event / update /
 * contribution over the same `search()` entry point.
 *
 * Matching is Slack-style: every whitespace-separated token in the query must
 * appear (case-insensitively) in the candidate's display name, so a query that
 * spans a space — `@Andrew W`, `@Fix login` — keeps matching.
 */
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { useProposalsStore } from 'stores/proposals';
import { useContributionsStore } from 'stores/contributions';
import { useActivityStore } from 'stores/activity';
import {
  MENTION_TYPES,
  mentionQueryTokens,
  displayMatchesTokens,
  type MentionType,
} from 'src/lib/mentions';

export interface MentionCandidate {
  type: MentionType;
  /** Entity identifier stored in the token (AID for people, id for the rest). */
  id: string;
  /** Name shown in the dropdown and embedded in the token. */
  display: string;
}

export function useMentionSearch() {
  const profilesStore = useProfilesStore();
  const projectsStore = useProjectsStore();
  const proposalsStore = useProposalsStore();
  const contributionsStore = useContributionsStore();
  const activityStore = useActivityStore();

  function searchPeople(tokens: string[], remaining: number): MentionCandidate[] {
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    for (const p of profilesStore.communityProfiles) {
      const aid = p.data.aid as string;
      const name = ((p.data.displayName as string) || '').trim();
      if (!aid || !name || seen.has(aid)) continue;
      if (!displayMatchesTokens(name, tokens)) continue;
      seen.add(aid);
      out.push({ type: 'person', id: aid, display: name });
      if (out.length >= remaining) break;
    }
    return out;
  }

  /** Search an id/title list store (projects, proposals, contributions). */
  function searchTitled(
    type: MentionType,
    items: ReadonlyArray<{ id?: string; title?: string }>,
    tokens: string[],
    remaining: number,
  ): MentionCandidate[] {
    const out: MentionCandidate[] = [];
    for (const it of items) {
      const id = it.id;
      const title = (it.title || '').trim();
      if (!id || !title) continue;
      if (!displayMatchesTokens(title, tokens)) continue;
      out.push({ type, id, display: title });
      if (out.length >= remaining) break;
    }
    return out;
  }

  /** Search published notices of one kind (events, updates). */
  function searchNotices(
    type: 'event' | 'update',
    tokens: string[],
    remaining: number,
  ): MentionCandidate[] {
    const out: MentionCandidate[] = [];
    for (const n of activityStore.notices) {
      if (n.type !== type || n.state !== 'published') continue;
      const title = (n.title || '').trim();
      if (!n.id || !title) continue;
      if (!displayMatchesTokens(title, tokens)) continue;
      out.push({ type, id: n.id, display: title });
      if (out.length >= remaining) break;
    }
    return out;
  }

  function candidatesFor(type: MentionType, tokens: string[], remaining: number): MentionCandidate[] {
    switch (type) {
      case 'person':
        return searchPeople(tokens, remaining);
      case 'project':
        return searchTitled('project', projectsStore.projects, tokens, remaining);
      case 'proposal':
        return searchTitled('proposal', proposalsStore.proposals, tokens, remaining);
      case 'contribution':
        return searchTitled('contribution', contributionsStore.contributions, tokens, remaining);
      case 'event':
        return searchNotices('event', tokens, remaining);
      case 'update':
        return searchNotices('update', tokens, remaining);
    }
  }

  /**
   * Return mention candidates matching `query` (the text typed after `@`),
   * drawn from every entity type in {@link MENTION_TYPES} order (people first).
   * An empty query returns the first `limit` candidates so the dropdown is
   * useful the moment `@` is typed.
   */
  function search(query: string, limit = 8): MentionCandidate[] {
    const tokens = mentionQueryTokens(query);
    const out: MentionCandidate[] = [];
    for (const type of MENTION_TYPES) {
      if (out.length >= limit) break;
      out.push(...candidatesFor(type, tokens, limit - out.length));
    }
    return out.slice(0, limit);
  }

  return { search };
}
