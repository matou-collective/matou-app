/**
 * The scan → approve-card routing seam (idss #1492 story 10). A scanned or
 * pasted `matou://signin` link becomes the approve-card route location; other
 * text is reported as "not a code" beside the pairing link.
 */
import { describe, it, expect, vi } from 'vitest';
import { signinLinkToLocation, routeSigninText } from 'src/composables/useSigninScan';
import type { Router } from 'vue-router';

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
});
