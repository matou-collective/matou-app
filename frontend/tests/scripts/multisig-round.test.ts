import { describe, it, expect } from 'vitest';
import { classifyMultisigRot } from 'src/lib/keri/multisigRound';

const ADMIN = 'BADM';
const MEMBER = 'BMEM';

describe('classifyMultisigRot', () => {
  it('returns round-1 when member is in rmids only', () => {
    const exn = { a: { smids: [ADMIN], rmids: [ADMIN, MEMBER] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('round-1');
  });

  it('returns round-2 when member is in smids', () => {
    const exn = { a: { smids: [ADMIN, MEMBER], rmids: [ADMIN, MEMBER] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('round-2');
  });

  it('returns unknown when member appears in neither', () => {
    const exn = { a: { smids: [ADMIN], rmids: [ADMIN] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('unknown');
  });

  it('returns unknown for malformed payloads', () => {
    expect(classifyMultisigRot({}, MEMBER)).toBe('unknown');
    expect(classifyMultisigRot({ a: {} }, MEMBER)).toBe('unknown');
    expect(classifyMultisigRot({ a: { smids: null, rmids: null } }, MEMBER)).toBe('unknown');
  });

  it('admin (first smid) is exposed by adminPrefixFromExn', async () => {
    const { adminPrefixFromExn } = await import('src/lib/keri/multisigRound');
    expect(adminPrefixFromExn({ a: { smids: [ADMIN, MEMBER] } })).toBe(ADMIN);
    expect(adminPrefixFromExn({ a: { smids: [] } })).toBeUndefined();
    expect(adminPrefixFromExn({})).toBeUndefined();
  });
});
