import { describe, it, expect } from 'vitest';
import {
  createStandingReader,
  latestSn,
  readStanding,
  revokedBySeals,
  revokedMessage,
  takeUntold,
  type KeyEventRecord,
  type StandingCredential,
  type ToldMemory,
} from 'src/lib/keri/credentialStanding';

// A credential revoked by its community stayed Active in the wallet and was
// still offered at a door (issue #687): revoking writes to the ISSUER's
// registry and tells the holder's agent nothing. The community anchors every
// registry event as a seal in its own key history, so the wallet reads a
// credential's standing there — the way the IDSS door does.

const ORG = 'EEPniUBM5MvRp-H_Lp_JVTbR9BEtgOa6Sp3gyypzjQZJ';
const OTHER_ISSUER = 'EOtherIssuerOtherIssuerOtherIssuerOtherIssuer';
const HOLDER = 'EExc8YEieUgrpaMxzn1gVQwrr9ftz0SynhRYfkpiMafL';
const ADMINISTRATOR = 'EObS0LtLz23wkQfoIlfdSKXNZvEoV0eZqlErkKrc9iPK';
const MEMBERSHIP = 'EJ22QRxPae1Yk06sWJIGW6925ZEg01QRHRcqomMBAhhb';

function icp(issuer = ORG): KeyEventRecord {
  return { ked: { t: 'icp', i: issuer, s: '0', a: [] } };
}
function anchor(said: string, s: '0' | '1', issuer = ORG, t = 'ixn'): KeyEventRecord {
  return { ked: { t, i: issuer, s: '5', a: [{ i: said, s, d: `E${s}-event-of-${said.slice(0, 6)}` }] } };
}

/** The community's key history once it has issued both and revoked Administrator. */
function historyAfterRevoke(): KeyEventRecord[] {
  return [icp(), anchor(MEMBERSHIP, '0'), anchor(ADMINISTRATOR, '0'), anchor(ADMINISTRATOR, '1')];
}

describe('revokedBySeals (issue #687)', () => {
  it('reads a credential as revoked once the issuer anchored its revocation', () => {
    const revoked = revokedBySeals(historyAfterRevoke(), ORG, [ADMINISTRATOR, MEMBERSHIP]);

    expect([...revoked]).toEqual([ADMINISTRATOR]);
  });

  it('reads a credential that was only issued as not revoked', () => {
    const revoked = revokedBySeals([icp(), anchor(ADMINISTRATOR, '0')], ORG, [ADMINISTRATOR]);

    expect(revoked.size).toBe(0);
  });

  it.each(['rot', 'drt'])('reads a revocation anchored in a %s event', (ilk) => {
    const revoked = revokedBySeals([icp(), anchor(ADMINISTRATOR, '1', ORG, ilk)], ORG, [ADMINISTRATOR]);

    expect(revoked.has(ADMINISTRATOR)).toBe(true);
  });

  it('takes no word on a credential from another identity’s events', () => {
    const revoked = revokedBySeals([icp(), anchor(ADMINISTRATOR, '1', OTHER_ISSUER)], ORG, [ADMINISTRATOR]);

    expect(revoked.size).toBe(0);
  });

  it('reads past anchors that are not seals and events that are not events', () => {
    const odd = [
      null,
      {},
      { ked: null },
      { ked: { t: 'ixn', i: ORG } },
      { ked: { t: 'ixn', i: ORG, a: 'not-a-list' } },
      { ked: { t: 'rot', i: ORG, a: ['a-digest', 7, null, { d: 'EOnlyADigest' }, { i: ADMINISTRATOR }] } },
      anchor(ADMINISTRATOR, '1'),
    ] as unknown as KeyEventRecord[];

    expect([...revokedBySeals(odd, ORG, [ADMINISTRATOR])]).toEqual([ADMINISTRATOR]);
  });
});

function held(said: string, over: Partial<StandingCredential> = {}): StandingCredential {
  return {
    sad: { d: said, i: ORG, a: { i: HOLDER, committee: 'administrator', communityName: 'Whakatōhea Demo' } },
    status: { s: '0', et: 'iss' },
    ...over,
  };
}

function historyOf(byIssuer: Record<string, KeyEventRecord[]>) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      async keyHistory(issuer: string) {
        asked.push(issuer);
        const history = byIssuer[issuer];
        if (!history) throw new Error(`no key history could be read for ${issuer}`);
        return history;
      },
    },
  };
}

describe('readStanding (issue #687)', () => {
  it('reads a credential its community revoked as revoked, though the agent still reads it live', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });

    const { credentials } = await readStanding(deps, [held(ADMINISTRATOR)], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
  });

  it('leaves a live credential as the agent read it', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });
    const membership = held(MEMBERSHIP, { sad: { d: MEMBERSHIP, i: ORG, a: { i: HOLDER } } });

    const { credentials, revealed } = await readStanding(deps, [membership], HOLDER);

    expect(credentials[0]).toBe(membership);
    expect(revealed).toEqual([]);
  });

  it('reports what the key history revealed, by the name on the card and its community', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });

    const { revealed } = await readStanding(deps, [held(ADMINISTRATOR)], HOLDER);

    expect(revealed).toEqual([
      { said: ADMINISTRATOR, name: 'Administrator', communityName: 'Whakatōhea Demo' },
    ]);
  });

  it('names a credential with no card name by its schema’s title', async () => {
    const { deps } = historyOf({ [ORG]: [icp(), anchor(MEMBERSHIP, '1')] });
    const membership: StandingCredential = {
      sad: { d: MEMBERSHIP, i: ORG, a: { i: HOLDER } },
      schema: { title: 'Membership' },
      status: { s: '0' },
    };

    const { revealed } = await readStanding(deps, [membership], HOLDER);

    expect(revealed.map((r) => r.name)).toEqual(['Membership']);
  });

  it('never reads a credential as revoked when the key history could not be read', async () => {
    const { deps } = historyOf({});
    const administrator = held(ADMINISTRATOR);

    const { credentials, revealed } = await readStanding(deps, [administrator], HOLDER);

    expect(credentials[0]).toBe(administrator);
    expect(revealed).toEqual([]);
  });

  it('reveals nothing the agent already read as revoked', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });
    const known = held(ADMINISTRATOR, { status: { s: '1', et: 'rev' } });

    const { credentials, revealed } = await readStanding(deps, [known], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
    expect(revealed).toEqual([]);
  });

  it('reads a credential issued to someone else as revoked, and reveals it to nobody', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });
    const theirs = held(ADMINISTRATOR, {
      sad: { d: ADMINISTRATOR, i: ORG, a: { i: 'ESomeoneElse', committee: 'administrator' } },
    });

    const { credentials, revealed } = await readStanding(deps, [theirs], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
    expect(revealed).toEqual([]);
  });

  it('reads each issuer’s key history once, however many of its credentials are held', async () => {
    const { deps, asked } = historyOf({ [ORG]: historyAfterRevoke(), [OTHER_ISSUER]: [icp(OTHER_ISSUER)] });
    const elsewhere = held('EElsewhere', { sad: { d: 'EElsewhere', i: OTHER_ISSUER, a: { i: HOLDER } } });

    await readStanding(deps, [held(ADMINISTRATOR), held(MEMBERSHIP), elsewhere], HOLDER);

    expect(asked.sort()).toEqual([ORG, OTHER_ISSUER].sort());
  });

  it('keeps the order the agent listed them in', async () => {
    const { deps } = historyOf({ [ORG]: historyAfterRevoke() });

    const { credentials } = await readStanding(deps, [held(MEMBERSHIP), held(ADMINISTRATOR)], HOLDER);

    expect(credentials.map((c) => c.sad?.d)).toEqual([MEMBERSHIP, ADMINISTRATOR]);
  });

  it('reads nothing when the wallet is empty', async () => {
    const { deps, asked } = historyOf({ [ORG]: historyAfterRevoke() });

    const { credentials } = await readStanding(deps, [], HOLDER);

    expect(credentials).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('latestSn (issue #687)', () => {
  // How far a copy of the issuer's key history reaches, so an agent whose copy
  // is behind the fresh one can be asked to catch up to it.
  const at = (s: string, issuer = ORG): KeyEventRecord => ({ ked: { t: 'ixn', i: issuer, s } });

  it('reads the highest sequence number, which is written in hex', () => {
    expect(latestSn([at('0'), at('9'), at('a'), at('1f')], ORG)).toBe(31);
  });

  it('counts only the issuer’s own events', () => {
    expect(latestSn([at('2'), at('7', OTHER_ISSUER)], ORG)).toBe(2);
  });

  it('reads an empty or unreadable history as holding nothing', () => {
    expect(latestSn([], ORG)).toBe(-1);
    expect(latestSn([{ ked: null }, { ked: { i: ORG, s: 'zz' } }] as KeyEventRecord[], ORG)).toBe(-1);
  });
});

/** The two places the app reads the community's key history, and the agent it can nudge. */
function sources(opts: { agent?: KeyEventRecord[] | Error; served?: KeyEventRecord[] | Error } = {}) {
  const state = {
    agent: opts.agent ?? [icp(), anchor(ADMINISTRATOR, '0')],
    served: opts.served ?? historyAfterRevoke(),
    clock: 1_000_000,
    agentReads: 0,
    servedReads: 0,
    catchUps: [] as Array<{ issuer: string; sn: number }>,
  };
  const give = (h: KeyEventRecord[] | Error) => {
    if (h instanceof Error) throw h;
    return h;
  };
  const reader = createStandingReader({
    async agentHistory() {
      state.agentReads++;
      return give(state.agent);
    },
    async servedHistory() {
      state.servedReads++;
      return give(state.served);
    },
    catchUp: (issuer, sn) => void state.catchUps.push({ issuer, sn }),
    now: () => state.clock,
    cacheMs: 15_000,
  });
  return { state, reader };
}

/** A history whose events are numbered as a key history numbers them. */
function numbered(events: KeyEventRecord[]): KeyEventRecord[] {
  return events.map((e, n) => ({ ked: { ...e.ked, s: n.toString(16) } }));
}

describe('createStandingReader (issue #687)', () => {
  it('reads a revocation the agent has not heard of from the history the community serves', async () => {
    const { reader } = sources();

    const { credentials } = await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
  });

  it('still reads the agent’s own copy when the community cannot be reached', async () => {
    const { reader } = sources({ agent: historyAfterRevoke(), served: new Error('offline') });

    const { credentials } = await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
  });

  it('leaves a credential as the agent read it when neither copy can be read', async () => {
    const { reader } = sources({ agent: new Error('locked'), served: new Error('offline') });
    const administrator = held(ADMINISTRATOR);

    const { credentials } = await reader.read([administrator], HOLDER);

    expect(credentials[0]).toBe(administrator);
  });

  it('asks the agent to catch up when its copy is behind the one served', async () => {
    const { reader, state } = sources({
      agent: numbered([icp(), anchor(ADMINISTRATOR, '0')]),
      served: numbered(historyAfterRevoke()),
    });

    await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(state.catchUps).toEqual([{ issuer: ORG, sn: 3 }]);
  });

  it('asks once for a point in the history, however many looks find the agent behind it', async () => {
    const { reader, state } = sources({
      agent: numbered([icp(), anchor(ADMINISTRATOR, '0')]),
      served: numbered(historyAfterRevoke()),
    });

    await reader.read([held(ADMINISTRATOR)], HOLDER);
    state.clock += 60_000;
    await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(state.catchUps).toHaveLength(1);
  });

  it('asks nothing of an agent whose copy is level', async () => {
    const { reader, state } = sources({
      agent: numbered(historyAfterRevoke()),
      served: numbered(historyAfterRevoke()),
    });

    await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(state.catchUps).toEqual([]);
  });

  it('reads the key history once for looks that come together', async () => {
    const { reader, state } = sources();

    await Promise.all([
      reader.read([held(ADMINISTRATOR)], HOLDER),
      reader.read([held(ADMINISTRATOR)], HOLDER),
    ]);
    state.clock += 5_000;
    await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(state.servedReads).toBe(1);
  });

  it('reads it afresh on a later look, so a revocation made since is seen', async () => {
    const { reader, state } = sources({ served: [icp(), anchor(ADMINISTRATOR, '0')] });
    await reader.read([held(ADMINISTRATOR)], HOLDER);

    state.served = historyAfterRevoke();
    state.clock += 60_000;
    const { credentials } = await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
  });

  it('tries again at once after a look that could read nothing', async () => {
    const { reader, state } = sources({ agent: new Error('locked'), served: new Error('offline') });
    await reader.read([held(ADMINISTRATOR)], HOLDER);

    state.served = historyAfterRevoke();
    const { credentials } = await reader.read([held(ADMINISTRATOR)], HOLDER);

    expect(credentials[0]?.status).toMatchObject({ s: '1', et: 'rev' });
  });
});

function memory(initial: string[] = [], opts: { broken?: boolean } = {}): ToldMemory & { saids: string[] } {
  const store = {
    saids: [...initial],
    read() {
      if (opts.broken) throw new Error('storage blocked');
      return [...store.saids];
    },
    write(saids: string[]) {
      if (opts.broken) throw new Error('storage blocked');
      store.saids = [...saids];
    },
  };
  return store;
}

const REVEALED = { said: ADMINISTRATOR, name: 'Administrator', communityName: 'Whakatōhea Demo' };

describe('takeUntold (issue #687)', () => {
  it('tells the member of a revocation they have not been told of', () => {
    expect(takeUntold([REVEALED], memory())).toEqual([REVEALED]);
  });

  it('tells them once: the second look tells nothing', () => {
    const told = memory();
    takeUntold([REVEALED], told);

    expect(takeUntold([REVEALED], told)).toEqual([]);
  });

  it('keeps what it was told of before', () => {
    const told = memory(['EEarlier']);
    takeUntold([REVEALED], told);

    expect(told.saids.sort()).toEqual([ADMINISTRATOR, 'EEarlier'].sort());
  });

  it('tells nothing when it cannot remember having told — never the same line on every look', () => {
    expect(takeUntold([REVEALED], memory([], { broken: true }))).toEqual([]);
  });
});

describe('revokedMessage (issue #687)', () => {
  it('names the community and the credential', () => {
    expect(revokedMessage(REVEALED)).toBe('Whakatōhea Demo revoked Administrator');
  });

  it('falls back to "Your community" when the credential names none', () => {
    expect(revokedMessage({ said: 'E1', name: 'Finance', communityName: '' })).toBe(
      'Your community revoked Finance',
    );
  });
});
