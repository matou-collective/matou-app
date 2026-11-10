/**
 * The scan → approve-card routing seam (idss #1492 story 10). A scanned or
 * pasted `matou://signin` link becomes the approve-card route location; other
 * text is reported as "not a code" beside the pairing link.
 */
import { describe, it, expect, vi } from 'vitest';
import { signinLinkToLocation, routeSigninText } from 'src/composables/useSigninScan';
import type { Router } from 'vue-router';
import { parseSigninLink, signinAskFromQuery } from 'src/lib/signin/link';

describe('signinLinkToLocation', () => {
  it('maps a signin link to the approve-card route with its fields as query', () => {
    const loc = signinLinkToLocation(
      'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_3f9&s=EMe&name=Home&service=Files',
    );
    expect(loc).toEqual({
      name: 'signin-approve',
      query: {
        door: 'https://id.example.nz/login',
        present: 'https://id.example.nz/login/app/present',
        c: 'c_3f9',
        s: 'EMe',
        name: 'Home',
        service: 'Files',
      },
    });
  });

  it('carries the present URL, omits absent optional fields, and rejects non-signin text', () => {
    const loc = signinLinkToLocation('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1');
    expect(loc).toEqual({ name: 'signin-approve', query: { door: 'https://d.nz', present: 'https://d.nz/p', c: 'n1' } });
    expect(signinLinkToLocation('matou://pair?id=x&pk=y&s=z')).toBeNull();
    // A link with no present is a door this app cannot answer — refused, never guessed.
    expect(signinLinkToLocation('matou://signin?door=https://d.nz&c=n1')).toBeNull();
  });
});

// A control-panel code carries `cred=` (the credential the door asks for, #683)
// and `offer=` (what the code offers, #688). Both must survive the hop from the
// scanned code to the approve card's route, or the card answers a different ask
// than the one the door made.
describe('signinLinkToLocation — a control-panel code', () => {
  const PANEL =
    'matou://signin?c=nonce-PANEL&cred=administrator&door=https://d.nz&name=Home&offer=seat-unlock&present=https://d.nz/p&s=ECommittee,EMembership&svc=the%20control%20panel';
  const UNLOCK = PANEL.replace('offer=seat-unlock', 'offer=unlock').replace('nonce-PANEL', 'nonce-UNLOCK');

  it('carries cred and offer onto the approve-card route', () => {
    const loc = signinLinkToLocation(PANEL) as { query: Record<string, string> };
    expect(loc.query.cred).toBe('administrator');
    expect(loc.query.offer).toBe('seat-unlock');
  });

  it('an unlock code opens the SAME approve-card route, saying it is an unlock', () => {
    const loc = signinLinkToLocation(UNLOCK) as { name: string; query: Record<string, string> };
    expect(loc.name).toBe('signin-approve');
    expect(loc.query.offer).toBe('unlock');
  });

  it('carries no sealing key, even off a code that still has one', () => {
    const loc = signinLinkToLocation(`${PANEL}&ek=DVERKEY`) as { query: Record<string, string> };
    expect(loc.query).not.toHaveProperty('ek');
  });

  it.each([PANEL, UNLOCK])('the ask the approve card rebuilds from the route is the ask the code carried', (code) => {
    const loc = signinLinkToLocation(code) as { query: Record<string, string> };
    expect(signinAskFromQuery(loc.query)).toEqual(parseSigninLink(code));
  });
});

describe('routeSigninText', () => {
  it('pushes the approve-card route for a valid link', async () => {
    const push = vi.fn(async () => undefined);
    const router = { push } as unknown as Router;
    const outcome = await routeSigninText(router, '  matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1  ');
    expect(outcome).toEqual({ status: 'navigated' });
    expect(push).toHaveBeenCalledWith({
      name: 'signin-approve',
      query: { door: 'https://d.nz', present: 'https://d.nz/p', c: 'n1' },
    });
  });

  it('reports not-a-code and does not navigate for junk', async () => {
    const push = vi.fn(async () => undefined);
    const router = { push } as unknown as Router;
    const outcome = await routeSigninText(router, 'hello');
    expect(outcome).toEqual({ status: 'not-a-code' });
    expect(push).not.toHaveBeenCalled();
  });

  it('does not answer the retired matou://unlock code — it is not a code (#688)', async () => {
    const push = vi.fn(async () => undefined);
    const router = { push } as unknown as Router;
    const outcome = await routeSigninText(
      router,
      'matou://unlock?panel=https://admin.example.nz&present=https://id.example.nz/login/app/unlock&u=u_2d7&ek=DFRESHKEY',
    );
    expect(outcome).toEqual({ status: 'not-a-code' });
    expect(push).not.toHaveBeenCalled();
  });
});
