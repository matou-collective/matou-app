import { describe, it, expect } from 'vitest';
import { actEmbedParts, parseActExn, planHistoryPush, statusOf } from 'src/lib/keri/steward/replicate';
import type { TelBundle } from 'src/lib/keri/steward/sigs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (i: number) => `A${B64[i]}` + 's'.repeat(86);
const m = (event: Record<string, unknown>, attachment = '') => ({ event, eventRaw: JSON.stringify(event), attachment });
const bundle: TelBundle = {
  acdc: m({ d: 'ECRED', ri: 'EREG' }),
  iss: m({ t: 'iss', d: 'EISS', i: 'ECRED' }, '-GAB'),
  issAnc: m({ t: 'ixn', d: 'EA1', s: '9' }, `-AAB${sig(1)}`),
  rev: m({ t: 'rev', d: 'EREV', i: 'ECRED' }),
  revAnc: m({ t: 'ixn', d: 'EA2', s: 'a' }, `-AAB${sig(0)}`),
};
const org = { group: 'EGRP', registry: 'EREG' };

describe('actEmbedParts', () => {
  it('iss carries acdc, iss and the signed anc', () => {
    const e = actEmbedParts(bundle, 'iss');
    expect(Object.keys(e)).toEqual(['acdc', 'iss', 'anc']);
    expect(e.anc!.atc).toBe(`-AAB${sig(1)}`);
  });
  it('rev also carries the issuance so a receiver can replay it first', () => {
    expect(Object.keys(actEmbedParts(bundle, 'rev'))).toEqual(['acdc', 'iss', 'issanc', 'rev', 'anc']);
  });
});

describe('parseActExn', () => {
  const paths = { anc: `-AAB${sig(1)}`, issanc: `-AAB${sig(1)}` };
  const exn = (gid: string, ri: string, r = '/multisig/iss') => ({
    r, a: { gid },
    e: { acdc: { d: 'ECRED', ri }, iss: { t: 'iss', d: 'EISS' }, anc: { t: 'ixn', d: 'EA1', s: '9' }, d: 'EEMB' },
  });
  it('builds a ReplayInput for our group and registry', () => {
    const r = parseActExn(exn('EGRP', 'EREG'), paths, org)!;
    expect(r.kind).toBe('iss');
    expect(r.anc.sigs).toEqual([sig(1)]);
    expect(JSON.parse(r.anc.raw).d).toBe('EA1');
  });
  it('ignores another group (Review Focus 4)', () => {
    expect(parseActExn(exn('EOTHER', 'EREG'), paths, org)).toBeNull();
  });
  it('ignores another registry, e.g. a legacy per-steward one (Review Focus 4)', () => {
    expect(parseActExn(exn('EGRP', 'ESTEWARDREG'), paths, org)).toBeNull();
  });
});

describe('planHistoryPush', () => {
  it('sends each peer what it has not been sent, upgrading iss→rev', () => {
    const plan = planHistoryPush(
      [{ said: 'C1', revoked: false }, { said: 'C2', revoked: true }],
      ['P1', 'P2'],
      { P1: { C1: 'iss', C2: 'iss' } },
    );
    expect(plan).toEqual([
      { peer: 'P1', said: 'C2', kind: 'rev' },
      { peer: 'P2', said: 'C1', kind: 'iss' },
      { peer: 'P2', said: 'C2', kind: 'rev' },
    ]);
  });
  it('sends nothing twice', () => {
    expect(planHistoryPush([{ said: 'C1', revoked: false }], ['P1'], { P1: { C1: 'iss' } })).toEqual([]);
  });
});

describe('statusOf', () => {
  // signify-ts clienting.js: `HTTP ${method} ${path} - ${res.status} ${res.statusText} - ${error}`
  const reject = (msg: string) => Promise.reject(new Error(msg));
  it('is 200 when the call resolves', async () => {
    expect(await statusOf(Promise.resolve({}))).toBe(200);
  });
  it('reads the status from a signify error with a statusText', async () => {
    expect(await statusOf(reject('HTTP POST /identifiers/matou-org/credentials - 400 Bad Request - {"title": "400 Bad Request"}'))).toBe(400);
  });
  it('reads the status from a signify error with an empty statusText', async () => {
    expect(await statusOf(reject('HTTP DELETE /identifiers/matou-org/credentials/EABC - 404  - {"title": "404 Not Found"}'))).toBe(404);
  });
  it('reads a 5xx', async () => {
    expect(await statusOf(reject('HTTP POST /identifiers/matou-org/credentials - 500 Internal Server Error - boom - 400 - x'))).toBe(500);
  });
  it('is 599 for a network failure', async () => {
    expect(await statusOf(Promise.reject(new TypeError('fetch failed')))).toBe(599);
  });
});
