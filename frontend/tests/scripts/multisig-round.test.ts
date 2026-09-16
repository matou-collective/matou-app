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

  // Issue #520: the round is a property of the rotation, not of the recipient.
  // An existing co-signer appears in BOTH rounds' smids, so inferring the round
  // from smids membership misclassifies its round-1 notification as round-2.
  // The explicit `a.round` field the sender stamps must win over inference.
  describe('explicit a.round (issue #520)', () => {
    const OTHER = 'BOTH'; // an existing co-signer, present in every round's smids

    it("classifies an existing co-signer's round-1 notification as round-1", () => {
      // Round-1 payload: admin + existing co-signer sign; the new member joins
      // rmids only. Without the explicit field the co-signer (in smids) would
      // be inferred as round-2.
      const exn = {
        a: { round: 'round-1', smids: [ADMIN, OTHER], rmids: [ADMIN, OTHER, MEMBER] },
      };
      expect(classifyMultisigRot(exn, OTHER)).toBe('round-1');
      // ...and the smids-only inference would indeed get it wrong:
      expect(
        classifyMultisigRot({ a: { smids: [ADMIN, OTHER], rmids: [ADMIN, OTHER, MEMBER] } }, OTHER),
      ).toBe('round-2');
    });

    it('the explicit round wins over what smids/rmids would infer', () => {
      const exn = { a: { round: 'round-1', smids: [ADMIN, MEMBER], rmids: [ADMIN, MEMBER] } };
      expect(classifyMultisigRot(exn, MEMBER)).toBe('round-1');
      const exn2 = { a: { round: 'round-2', smids: [ADMIN], rmids: [ADMIN, MEMBER] } };
      expect(classifyMultisigRot(exn2, MEMBER)).toBe('round-2');
    });

    it('classifies both parties consistently from the explicit round', () => {
      const r1 = { a: { round: 'round-1', smids: [ADMIN, OTHER], rmids: [ADMIN, OTHER, MEMBER] } };
      expect(classifyMultisigRot(r1, ADMIN)).toBe('round-1');
      expect(classifyMultisigRot(r1, MEMBER)).toBe('round-1');
      const r2 = { a: { round: 'round-2', smids: [ADMIN, OTHER, MEMBER], rmids: [ADMIN, OTHER, MEMBER] } };
      expect(classifyMultisigRot(r2, OTHER)).toBe('round-2');
      expect(classifyMultisigRot(r2, MEMBER)).toBe('round-2');
    });

    it('falls back to smids/rmids inference when a.round is absent or invalid', () => {
      // Backward compatibility with EXNs from clients predating the field.
      expect(classifyMultisigRot({ a: { smids: [ADMIN], rmids: [ADMIN, MEMBER] } }, MEMBER)).toBe('round-1');
      expect(classifyMultisigRot({ a: { round: 'nonsense', smids: [ADMIN, MEMBER], rmids: [ADMIN, MEMBER] } }, MEMBER)).toBe('round-2');
    });
  });

  it('admin (first smid) is exposed by adminPrefixFromExn', async () => {
    const { adminPrefixFromExn } = await import('src/lib/keri/multisigRound');
    expect(adminPrefixFromExn({ a: { smids: [ADMIN, MEMBER] } })).toBe(ADMIN);
    expect(adminPrefixFromExn({ a: { smids: [] } })).toBeUndefined();
    expect(adminPrefixFromExn({})).toBeUndefined();
  });
});
