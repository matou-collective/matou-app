import { describe, it, expect } from 'vitest';
import {
  admitCommunityGrants,
  admittedMessage,
  waitForCredential,
  type GrantNote,
} from 'src/lib/keri/grantAdmission';

// A credential issued AFTER a member joined reaches them as an IPEX grant, and
// nothing admitted it (issue #685): the Wallet page never showed it and a door
// asking for it found nothing. These run the admission against a fake agent
// that behaves as KERIA does — an admit only lands a credential in the wallet
// when the agent has resolved that credential's schema; otherwise it escrows.

const ORG = 'EEPniUBM5MvRp-H_Lp_JVTbR9BEtgOa6Sp3gyypzjQZJ';
const HOLDER = 'EExc8YEieUgrpaMxzn1gVQwrr9ftz0SynhRYfkpiMafL';
const STRANGER = 'EStrangerAidStrangerAidStrangerAidStrangerAid';
const COMMITTEE_SCHEMA = 'INmmplPE8Xa26UYUB7NeznK7JmdwiQGcN__mgmgLFRJg';

interface Acdc {
  d: string;
  s: string;
  i: string;
  a: { i: string; committee?: string; communityName?: string; display?: { name?: string } };
}

function administrator(over: Partial<Acdc> = {}): Acdc {
  return {
    d: 'ECredAdministrator',
    s: COMMITTEE_SCHEMA,
    i: ORG,
    a: { i: HOLDER, committee: 'administrator', communityName: 'Whakatōhea Demo' },
    ...over,
  };
}

function grantNote(grantSaid: string, over: Partial<GrantNote> = {}): GrantNote {
  return { i: `note-${grantSaid}`, r: false, a: { r: '/exn/ipex/grant', d: grantSaid }, ...over };
}

function fakeAgent(opts: {
  grants: Record<string, Acdc>;
  notes: GrantNote[];
  wallet?: Acdc[];
  schemasOnOffer?: string[];
  failAdmitFor?: string[];
}) {
  const wallet: Acdc[] = [...(opts.wallet ?? [])];
  const notes = opts.notes.map((n) => ({ ...n, a: { ...n.a } }));
  const resolvedSchemas = new Set<string>();
  const admits: string[] = [];
  const issuersResolved: string[] = [];

  const client = {
    exchanges: () => ({
      get: async (said: string) => {
        const acdc = opts.grants[said];
        if (!acdc) throw new Error(`HTTP GET /exchanges/${said} - 404 Not Found`);
        return { exn: { i: acdc.i, e: { acdc } } };
      },
      createExchangeMessage: async (
        _hab: unknown,
        route: string,
        _payload: unknown,
        _embeds: unknown,
        recipient: string,
        _datetime: string | undefined,
        dig: string,
      ) => [{ route, recipient, dig }, ['sig'], '-atc'],
    }),
    identifiers: () => ({ get: async (name: string) => ({ name, prefix: HOLDER }) }),
    ipex: () => ({
      submitAdmit: async (_name: string, admit: unknown) => {
        const grantSaid = (admit as { dig: string }).dig;
        if (opts.failAdmitFor?.includes(grantSaid)) throw new Error('KERIA refused the admit');
        admits.push(grantSaid);
        const acdc = opts.grants[grantSaid];
        // KERIA escrows a credential whose schema the agent has never resolved.
        if (resolvedSchemas.has(acdc.s)) wallet.push(acdc);
      },
    }),
    notifications: () => ({
      mark: async (id: string) => {
        const note = notes.find((n) => n.i === id);
        if (note) note.r = true;
      },
    }),
    credentials: () => ({
      list: async (kargs?: { filter?: Record<string, unknown> }) => {
        const said = kargs?.filter?.['-d'];
        return wallet.filter((c) => !said || c.d === said).map((sad) => ({ sad }));
      },
    }),
  };

  return {
    deps: {
      client,
      aidName: 'tairea',
      orgAid: ORG,
      resolveSchemas: async () => {
        for (const s of opts.schemasOnOffer ?? [COMMITTEE_SCHEMA]) resolvedSchemas.add(s);
      },
      resolveIssuer: async (aid: string) => {
        issuersResolved.push(aid);
      },
    },
    notes,
    walletSaids: () => wallet.map((c) => c.d),
    admits,
    issuersResolved,
    isRead: (grantSaid: string) => notes.find((n) => n.a.d === grantSaid)?.r,
  };
}

describe('admitCommunityGrants (issue #685)', () => {
  it('puts a credential the community issued after joining into the wallet', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator() },
      notes: [grantNote('EGrant1')],
    });

    await admitCommunityGrants(agent.deps, agent.notes);

    expect(agent.walletSaids()).toEqual(['ECredAdministrator']);
    expect(agent.isRead('EGrant1')).toBe(true);
  });

  it('reports what was admitted by the name on its card and the community that issued it', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator() },
      notes: [grantNote('EGrant1')],
    });

    const admitted = await admitCommunityGrants(agent.deps, agent.notes);

    expect(admitted).toEqual([
      {
        said: 'ECredAdministrator',
        schema: COMMITTEE_SCHEMA,
        name: 'Administrator',
        communityName: 'Whakatōhea Demo',
      },
    ]);
  });

  it('names a credential by the name its community gave it', async () => {
    const acdc = administrator({
      d: 'ECredFinance',
      a: { i: HOLDER, committee: 'finance', display: { name: 'Komiti Pūtea' } },
    });
    const agent = fakeAgent({ grants: { EGrant1: acdc }, notes: [grantNote('EGrant1')] });

    const admitted = await admitCommunityGrants(agent.deps, agent.notes);

    expect(admitted.map((a) => a.name)).toEqual(['Komiti Pūtea']);
  });

  it('leaves a grant from anyone but the community untouched', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator({ i: STRANGER }) },
      notes: [grantNote('EGrant1')],
    });

    const admitted = await admitCommunityGrants(agent.deps, agent.notes);

    expect(admitted).toEqual([]);
    expect(agent.admits).toEqual([]);
    expect(agent.walletSaids()).toEqual([]);
    expect(agent.isRead('EGrant1')).toBe(false);
  });

  it('leaves a credential the community issued to someone else untouched', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator({ a: { i: STRANGER, committee: 'administrator' } }) },
      notes: [grantNote('EGrant1')],
    });

    await admitCommunityGrants(agent.deps, agent.notes);

    expect(agent.admits).toEqual([]);
    expect(agent.isRead('EGrant1')).toBe(false);
  });

  it('does not admit a second time when the credential is already in the wallet', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator() },
      notes: [grantNote('EGrant1')],
      wallet: [administrator()],
    });

    const admitted = await admitCommunityGrants(agent.deps, agent.notes);

    expect(agent.admits).toEqual([]);
    expect(admitted).toEqual([]);
    expect(agent.isRead('EGrant1')).toBe(true);
  });

  it('ignores grants already read and notifications that are not grants', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator(), EGrant2: administrator({ d: 'ECredOther' }) },
      notes: [
        grantNote('EGrant1', { r: true }),
        { i: 'note-x', r: false, a: { r: '/exn/matou/registration/decline', d: 'EGrant2' } },
      ],
    });

    await admitCommunityGrants(agent.deps, agent.notes);

    expect(agent.admits).toEqual([]);
  });

  it('carries on to the next grant when one fails, and leaves the failed one to retry', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator(), EGrant2: administrator({ d: 'ECredFinance' }) },
      notes: [grantNote('EGrant1'), grantNote('EGrant2')],
      failAdmitFor: ['EGrant1'],
    });

    const admitted = await admitCommunityGrants(agent.deps, agent.notes);

    expect(admitted.map((a) => a.said)).toEqual(['ECredFinance']);
    expect(agent.isRead('EGrant1')).toBe(false);
    expect(agent.isRead('EGrant2')).toBe(true);
  });

  it('pulls the issuer’s key history after admitting, so an escrowed credential can land', async () => {
    const agent = fakeAgent({
      grants: { EGrant1: administrator() },
      notes: [grantNote('EGrant1')],
    });

    await admitCommunityGrants(agent.deps, agent.notes);

    expect(agent.issuersResolved).toEqual([ORG]);
  });

  it('does no work against the agent when there is nothing to admit', async () => {
    let resolved = 0;
    const agent = fakeAgent({ grants: {}, notes: [] });

    await admitCommunityGrants(
      { ...agent.deps, resolveSchemas: async () => void resolved++ },
      agent.notes,
    );

    expect(resolved).toBe(0);
  });
});

describe('waitForCredential (issue #685)', () => {
  // KERIA works an admit in the background: the credential is in the wallet a
  // few seconds after the admit is accepted, not when it returns.
  function slowAgent(landsOnRead: number) {
    let reads = 0;
    return {
      credentials: () => ({
        list: async () => (++reads >= landsOnRead ? [{ sad: { d: 'ECredAdministrator' } }] : []),
      }),
      reads: () => reads,
    };
  }
  const noSleep = async () => {};

  it('answers true once the credential is in the wallet', async () => {
    const agent = slowAgent(3);

    const landed = await waitForCredential(agent, 'ECredAdministrator', { attempts: 5, sleep: noSleep });

    expect(landed).toBe(true);
    expect(agent.reads()).toBe(3);
  });

  it('answers false when the credential never lands, rather than waiting for ever', async () => {
    const agent = slowAgent(99);

    const landed = await waitForCredential(agent, 'ECredAdministrator', { attempts: 4, sleep: noSleep });

    expect(landed).toBe(false);
    expect(agent.reads()).toBe(4);
  });
});

describe('admittedMessage (issue #685)', () => {
  it('names the community and the credential', () => {
    expect(
      admittedMessage({ said: 'E1', schema: 'S', name: 'Administrator', communityName: 'Whakatōhea Demo' }),
    ).toBe('Whakatōhea Demo issued you Administrator');
  });

  it('falls back to "Your community" when the credential names none', () => {
    expect(admittedMessage({ said: 'E1', schema: 'S', name: 'Finance', communityName: '' })).toBe(
      'Your community issued you Finance',
    );
  });
});
