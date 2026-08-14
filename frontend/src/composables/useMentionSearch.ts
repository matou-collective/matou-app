/**
 * Typeahead search backing the chat @-mention composer (issue #12).
 *
 * All six mentionable entity types are already synced client-side, so the
 * search reads local Pinia stores — no new backend API. The first PR wires the
 * `person` type (community profiles); a follow-up adds project / proposal /
 * event / update / contribution over the same `search()` entry point.
 */
import { useProfilesStore } from 'stores/profiles';
import type { MentionType } from 'src/lib/mentions';

export interface MentionCandidate {
  type: MentionType;
  /** Entity identifier stored in the token (AID for people). */
  id: string;
  /** Name shown in the dropdown and embedded in the token. */
  display: string;
}

export function useMentionSearch() {
  const profilesStore = useProfilesStore();

  function searchPeople(query: string, limit: number): MentionCandidate[] {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    for (const p of profilesStore.communityProfiles) {
      const aid = p.data.aid as string;
      const name = ((p.data.displayName as string) || '').trim();
      if (!aid || !name || seen.has(aid)) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      seen.add(aid);
      out.push({ type: 'person', id: aid, display: name });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Return mention candidates matching `query` (the text typed after `@`).
   * An empty query returns the first `limit` people so the dropdown is useful
   * the moment `@` is typed.
   */
  function search(query: string, limit = 8): MentionCandidate[] {
    return searchPeople(query, limit);
  }

  return { search };
}
