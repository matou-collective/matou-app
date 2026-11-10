/**
 * useSignoutEverywhere — the identity screen's take-back controller (#665). The
 * state machine (idle → working → done | failed) is driven with injected deps, so
 * no signify-ts, store or live door is needed. It proves the request is SIGNED
 * and posted to the derived apex door, and that every failure path lands `failed`
 * without ever claiming sessions were ended (AC2/AC4).
 */
import { describe, it, expect, vi } from 'vitest';
import { useSignoutEverywhere, type SignoutEverywhereDeps } from 'src/composables/useSignoutEverywhere';
import { panelSignoutMessage, type PanelSignoutVerdict } from 'src/lib/panel/signout';
import type { CommunityDescriptor } from 'src/lib/descriptor';

const DOOR = 'https://whakatohea.idss.nz/authz/panel/signout-everywhere';

function descriptor(over: Partial<CommunityDescriptor> = {}): CommunityDescriptor {
  return {
    version: '1.1',
    backend_kind: 'idss',
    admins: [],
    schemas: {},
    api_url: 'https://whakatohea.idss.nz/api/v1/idip',
    ...over,
  };
}

function deps(over: Partial<SignoutEverywhereDeps> = {}): SignoutEverywhereDeps {
  return {
    getDescriptor: async () => descriptor(),
    holderAid: () => 'Etama',
    sign: async () => '0Bsignature',
    post: async () => ({ outcome: 'signed-out' }) as PanelSignoutVerdict,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('useSignoutEverywhere', () => {
  it('signs the door-bound message and posts it, landing done on 204 (AC2/AC3)', async () => {
    const sign = vi.fn(async () => '0Bsignature');
    const post = vi.fn(async () => ({ outcome: 'signed-out' }) as PanelSignoutVerdict);
    const { status, signOut } = useSignoutEverywhere(deps({ sign, post }));
    expect(status.value).toBe('idle');
    await signOut();
    expect(sign).toHaveBeenCalledWith(panelSignoutMessage(DOOR, 'Etama', 1_700_000_000_000));
    expect(post).toHaveBeenCalledWith(DOOR, {
      aid: 'Etama',
      signed_at: 1_700_000_000_000,
      signature: '0Bsignature',
    });
    expect(status.value).toBe('done');
  });

  it('a refusal lands failed — nothing claims sessions were ended (AC4)', async () => {
    const { status, signOut } = useSignoutEverywhere(
      deps({ post: async () => ({ outcome: 'refused' }) as PanelSignoutVerdict }),
    );
    await signOut();
    expect(status.value).toBe('failed');
  });

  it('an unreachable community lands failed (AC4)', async () => {
    const { status, signOut } = useSignoutEverywhere(
      deps({ post: async () => ({ outcome: 'unreachable' }) as PanelSignoutVerdict }),
    );
    await signOut();
    expect(status.value).toBe('failed');
  });

  it('a descriptor with no derivable door fails without posting anything', async () => {
    const post = vi.fn(async () => ({ outcome: 'signed-out' }) as PanelSignoutVerdict);
    const { status, signOut } = useSignoutEverywhere(
      deps({ getDescriptor: async () => descriptor({ api_url: undefined }), post }),
    );
    await signOut();
    expect(post).not.toHaveBeenCalled();
    expect(status.value).toBe('failed');
  });

  it('a wallet-side signer error lands failed, never a false done', async () => {
    const { status, signOut } = useSignoutEverywhere(
      deps({
        sign: async () => {
          throw new Error('no signer');
        },
      }),
    );
    await signOut();
    expect(status.value).toBe('failed');
  });

  it('is idempotent against a double-press: a second call while done does not re-post', async () => {
    const post = vi.fn(async () => ({ outcome: 'signed-out' }) as PanelSignoutVerdict);
    const { status, signOut } = useSignoutEverywhere(deps({ post }));
    await signOut();
    await signOut();
    expect(post).toHaveBeenCalledTimes(1);
    expect(status.value).toBe('done');
  });

  it('reset returns to idle so the steward can try again after a failure', async () => {
    const { status, signOut, reset } = useSignoutEverywhere(
      deps({ post: async () => ({ outcome: 'refused' }) as PanelSignoutVerdict }),
    );
    await signOut();
    expect(status.value).toBe('failed');
    reset();
    expect(status.value).toBe('idle');
  });
});
