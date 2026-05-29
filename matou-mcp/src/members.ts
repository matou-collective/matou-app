import type { MatouClient } from "./backend.js";

export interface Member {
  aid: string;
  name: string;
}

// A KERI AID is a long self-addressing identifier; treat anything starting with
// an uppercase letter and >=40 chars with no spaces as already-an-AID.
function looksLikeAid(s: string): boolean {
  return /^[A-Z][A-Za-z0-9_-]{39,}$/.test(s) && !s.includes(" ");
}

export class MemberDirectory {
  private readonly byName = new Map<string, string[]>();
  private readonly byAid = new Map<string, string>();

  constructor(members: Member[]) {
    for (const m of members) {
      if (!m.aid) continue;
      this.byAid.set(m.aid, m.name);
      if (m.name) {
        const key = m.name.toLowerCase();
        this.byName.set(key, [...(this.byName.get(key) ?? []), m.aid]);
      }
    }
  }

  resolve(query: string): string {
    if (looksLikeAid(query)) return query;
    const matches = this.byName.get(query.toLowerCase()) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new Error(`No member matching "${query}". Use resolve_member to list members, or pass an AID.`);
    throw new Error(`Name "${query}" is ambiguous — matches AIDs: ${matches.join(", ")}. Pass the AID instead.`);
  }

  name(aid: string): string | undefined {
    return this.byAid.get(aid);
  }

  list(): Member[] {
    return [...this.byAid].map(([aid, name]) => ({ aid, name }));
  }

  static async load(client: MatouClient): Promise<MemberDirectory> {
    const members: Member[] = [];
    const seen = new Set<string>();
    const add = (aid?: string, name?: string) => {
      if (aid && !seen.has(aid)) {
        seen.add(aid);
        members.push({ aid, name: name ?? "" });
      }
    };
    try {
      const profiles = await client.get<{ SharedProfile?: { data: { aid: string; displayName: string } }[] }>(
        "/api/v1/profiles",
      );
      for (const p of profiles.SharedProfile ?? []) add(p.data?.aid, p.data?.displayName);
    } catch {
      /* profiles optional */
    }
    try {
      const community = await client.get<{ members?: { aid: string; name?: string; displayName?: string }[] }>(
        "/api/v1/community/members",
      );
      for (const m of community.members ?? []) add(m.aid, m.name ?? m.displayName);
    } catch {
      /* members optional */
    }
    return new MemberDirectory(members);
  }
}
