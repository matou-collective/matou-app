/**
 * The control-panel take-back door client (#665, idss #1935). Every wire shape
 * here is pinned to idss #1935's MERGED control plane
 * (internal/controlapi/panelepoch.go @ main): the /authz door path, the
 * `idss-panel-signout:` bound-message prefix, the {aid, signed_at, signature}
 * body, and the 204-success / non-2xx-refusal / thrown-unreachable mapping. A
 * drift on either side reds this test, so neither repo guesses the wire.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  panelSignoutDoor,
  panelSignoutMessage,
  postPanelSignout,
  runPanelSignoutEverywhere,
  PANEL_SIGNOUT_PATH,
  type PanelSignoutBody,
} from 'src/lib/panel/signout';

// The descriptor served by an IDIP gateway (idss descriptor_1_1_served_test.go):
// the steward API rides the apex ORIGIN, the IdP login is on id.<apex>.
const API_URL = 'https://whakatohea.idss.nz/api/v1/idip';
const SIGNIN_URL = 'https://id.whakatohea.idss.nz/login';
const DOOR = 'https://whakatohea.idss.nz/authz/panel/signout-everywhere';

describe('panelSignoutDoor', () => {
  it('derives the apex-origin door from api_url (its origin IS the apex origin)', () => {
    expect(panelSignoutDoor({ apiUrl: API_URL })).toBe(DOOR);
  });

  it('falls back to signin.url, dropping the id.<apex> label, to the same apex', () => {
    expect(panelSignoutDoor({ signinUrl: SIGNIN_URL })).toBe(DOOR);
  });

  it('prefers api_url when both are present', () => {
    expect(panelSignoutDoor({ apiUrl: API_URL, signinUrl: SIGNIN_URL })).toBe(DOOR);
  });

  it('is null when the descriptor carries no address (non-IDSS / not founded)', () => {
    expect(panelSignoutDoor({})).toBeNull();
    expect(panelSignoutDoor({ apiUrl: 'not a url' })).toBeNull();
  });
});

describe('panelSignoutMessage', () => {
  it('binds idss-panel-signout:<door>:<aid>:<signed_at> (idss panelSignoutMessage)', () => {
    expect(panelSignoutMessage(DOOR, 'Etama', 1_700_000_000_000)).toBe(
      'idss-panel-signout:https://whakatohea.idss.nz/authz/panel/signout-everywhere:Etama:1700000000000',
    );
  });
});

describe('postPanelSignout', () => {
  const body: PanelSignoutBody = { aid: 'Etama', signed_at: 1_700_000_000_000, signature: '0BExampleSig' };

  it('204 → signed out, posting {aid, signed_at, signature} to the door', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const verdict = await postPanelSignout(DOOR, body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'signed-out' });
    expect(fetchImpl).toHaveBeenCalledWith(DOOR, expect.objectContaining({ method: 'POST' }));
    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual(body);
  });

  it('400 / 401 / 409 all refuse — the epoch did not move, nothing claims sessions ended', async () => {
    for (const status of [400, 401, 409]) {
      const fetchImpl = vi.fn(async () => new Response('{}', { status }));
      const verdict = await postPanelSignout(DOOR, body, fetchImpl as unknown as typeof fetch);
      expect(verdict).toEqual({ outcome: 'refused' });
    }
  });

  it('a thrown fetch is unreachable, never a refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postPanelSignout(DOOR, body, fetchImpl as unknown as typeof fetch)).toEqual({
      outcome: 'unreachable',
    });
  });
});

describe('runPanelSignoutEverywhere', () => {
  it('signs the bound message and posts it, returning the door verdict', async () => {
    const sign = vi.fn(async () => '0BsignatureOverTheBoundMessage');
    const post = vi.fn(async () => ({ outcome: 'signed-out' as const }));
    const verdict = await runPanelSignoutEverywhere(
      { door: DOOR, aid: 'Etama', signedAt: 1_700_000_000_000 },
      { sign, post },
    );
    expect(sign).toHaveBeenCalledWith(panelSignoutMessage(DOOR, 'Etama', 1_700_000_000_000));
    expect(post).toHaveBeenCalledWith(DOOR, {
      aid: 'Etama',
      signed_at: 1_700_000_000_000,
      signature: '0BsignatureOverTheBoundMessage',
    });
    expect(verdict).toEqual({ outcome: 'signed-out' });
  });

  it('PANEL_SIGNOUT_PATH is the /authz gate surface (idss panelSignoutPath)', () => {
    expect(PANEL_SIGNOUT_PATH).toBe('/authz/panel/signout-everywhere');
  });
});
