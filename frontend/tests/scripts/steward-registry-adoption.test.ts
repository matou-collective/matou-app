import { describe, it, expect, vi } from 'vitest';
import { ensureOrgRegistry, type AdoptionDeps } from 'src/lib/keri/steward/registryAdoption';
import { RegistryNotAdopted } from 'src/lib/keri/steward/errors';

function ev(obj: Record<string, unknown>, proto = 'KERI'): string {
  const body = JSON.stringify({ v: `${proto}10JSON000000_`, ...obj });
  return body.replace('000000', new TextEncoder().encode(body).length.toString(16).padStart(6, '0'));
}
const SIG = 'AA' + 'x'.repeat(86);
const exportText =
  ev({ t: 'icp', d: 'EGRP', i: 'EGRP', s: '0' }) + '-AAB' + SIG +
  ev({ t: 'ixn', d: 'EANC', i: 'EGRP', s: '1', a: [{ i: 'EREG', s: '0', d: 'EREG' }] }) + '-AAB' + SIG +
  ev({ t: 'vcp', d: 'EREG', i: 'EREG', s: '0', ii: 'EGRP' }) + '-GAB' +
  ev({ d: 'ECRED', i: 'EGRP', ri: 'EREG' }, 'ACDC');

function deps(over: Partial<AdoptionDeps> = {}): AdoptionDeps {
  let listed: string[] = [];
  return {
    listRegistries: vi.fn(async () => listed),
    heldCredentialSaids: vi.fn(async () => ['ECRED']),
    exportCredential: vi.fn(async () => exportText),
    createFromEvents: vi.fn(async () => { listed = ['EREG']; }),
    sleep: async () => {},
    ...over,
  };
}

describe('ensureOrgRegistry', () => {
  it('is a no-op when the agent already lists the registry', async () => {
    const d = deps({ listRegistries: async () => ['EREG'] });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('present');
    expect(d.createFromEvents).not.toHaveBeenCalled();
  });
  it('adopts from the original vcp + anchoring ixn + its sigs', async () => {
    const d = deps();
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('adopted');
    const [vcp, anc, sigs] = (d.createFromEvents as any).mock.calls[0];
    expect(vcp.d).toBe('EREG');
    expect(anc.d).toBe('EANC');
    expect(sigs).toEqual([SIG]);
  });
  it('polls list until the escrow resolves (op done is not trusted)', async () => {
    let calls = 0;
    const d = deps({
      listRegistries: async () => (++calls >= 4 ? ['EREG'] : []),
      createFromEvents: async () => {},
    });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('adopted');
  });
  it('refuses when the agent holds nothing from the registry', async () => {
    const d = deps({ heldCredentialSaids: async () => [] });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).rejects.toBeInstanceOf(RegistryNotAdopted);
  });
  it('refuses when the registry never lists within the budget', async () => {
    const d = deps({ createFromEvents: async () => {} });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d, { timeoutMs: 0 })).rejects.toBeInstanceOf(RegistryNotAdopted);
  });
  it('surfaces an anchoring ixn with no parseable signatures as RegistryNotAdopted', async () => {
    const unsigned =
      ev({ t: 'icp', d: 'EGRP', i: 'EGRP', s: '0' }) + '-AAB' + SIG +
      ev({ t: 'ixn', d: 'EANC', i: 'EGRP', s: '1', a: [{ i: 'EREG', s: '0', d: 'EREG' }] }) +
      ev({ t: 'vcp', d: 'EREG', i: 'EREG', s: '0', ii: 'EGRP' }) + '-GAB' +
      ev({ d: 'ECRED', i: 'EGRP', ri: 'EREG' }, 'ACDC');
    const d = deps({ exportCredential: async () => unsigned });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).rejects.toBeInstanceOf(RegistryNotAdopted);
    expect(d.createFromEvents).not.toHaveBeenCalled();
  });
});
