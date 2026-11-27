import { describe, it, expect, vi } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';

vi.mock('src/lib/secureStorage', () => ({ secureStorage: { getItem: vi.fn(async () => null), setItem: vi.fn() } }));

describe('KERIClient.ensureOrgRegistryAdopted single-flight', () => {
  it('concurrent callers share one adoption; a later call runs afresh', async () => {
    const kc = new KERIClient();
    const list = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); return [{ regk: 'EREG' }]; });
    (kc as unknown as { client: unknown }).client = { registries: () => ({ list }) };
    const [a, b] = await Promise.all([kc.ensureOrgRegistryAdopted('EG', 'EREG'), kc.ensureOrgRegistryAdopted('EG', 'EREG')]);
    expect([a, b]).toEqual(['present', 'present']);
    expect(list).toHaveBeenCalledTimes(1);
    await kc.ensureOrgRegistryAdopted('EG', 'EREG');
    expect(list).toHaveBeenCalledTimes(2);
  });
});
