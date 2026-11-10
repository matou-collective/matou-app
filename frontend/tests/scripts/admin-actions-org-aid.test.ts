import { describe, it, expect } from 'vitest';
import { resolveOrgGroupPrefix } from 'src/composables/useAdminActions';
import { NotJoined } from 'src/lib/keri/steward/errors';

const client = (aids: Array<{ name: string; prefix: string }>) => ({ identifiers: () => ({ list: async () => ({ aids }) }) });

describe('resolveOrgGroupPrefix', () => {
  it('returns the org AID from config when the wallet holds it', async () => {
    const c = client([{ name: 'me', prefix: 'EME' }, { name: 'matou', prefix: 'EGRP' }]);
    await expect(resolveOrgGroupPrefix(c as never, { organization: { aid: 'EGRP' } } as never, null)).resolves.toBe('EGRP');
  });
  it('falls back to the stored org AID', async () => {
    const c = client([{ name: 'matou', prefix: 'EGRP' }]);
    await expect(resolveOrgGroupPrefix(c as never, null, 'EGRP')).resolves.toBe('EGRP');
  });
  it('never returns a personal AID — throws NotJoined (e2e test 2 false green)', async () => {
    const c = client([{ name: 'matou-member', prefix: 'EME' }]);
    await expect(resolveOrgGroupPrefix(c as never, { organization: { aid: 'EGRP' } } as never, null)).rejects.toBeInstanceOf(NotJoined);
  });
});
