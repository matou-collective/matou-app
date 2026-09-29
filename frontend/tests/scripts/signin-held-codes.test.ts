/**
 * The sign-in codes the wallet will not answer again (#675, #690): a code a
 * sign-in site has spent, expired or never knew. Held for the unlocked session
 * whichever card opens the code, and dropped whole on lock or exit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { holdCode, heldCode, clearHeldCodes } from 'src/lib/signin/heldCodes';

const HOME = 'https://id.home.nz/login';
const OTHER = 'https://id.other.nz/login';

beforeEach(() => {
  clearHeldCodes();
});

describe('the held codes', () => {
  it('holds nothing until a site has answered', () => {
    expect(heldCode(HOME, 'c_1')).toBeNull();
  });

  it('holds the one code, and says why', () => {
    holdCode(HOME, 'c_1', 'spent');
    holdCode(HOME, 'c_2', 'expired');
    holdCode(HOME, 'c_3', 'unknown');
    expect(heldCode(HOME, 'c_1')).toBe('spent');
    expect(heldCode(HOME, 'c_2')).toBe('expired');
    expect(heldCode(HOME, 'c_3')).toBe('unknown');
    expect(heldCode(HOME, 'c_4')).toBeNull();
  });

  it('is a code of ONE sign-in site: the same id at another site is not held', () => {
    holdCode(HOME, 'c_1', 'spent');
    expect(heldCode(OTHER, 'c_1')).toBeNull();
  });

  it('knows a sign-in site by its address, with or without the trailing slash', () => {
    holdCode(`${HOME}/`, 'c_1', 'spent');
    expect(heldCode(HOME, 'c_1')).toBe('spent');
  });

  it('keeps the first reason: a dead code does not come back to life as another kind', () => {
    holdCode(HOME, 'c_1', 'expired');
    holdCode(HOME, 'c_1', 'spent');
    expect(heldCode(HOME, 'c_1')).toBe('expired');
  });

  it.each([
    ['a blank code', HOME, ''],
    ['a blank site', '', 'c_1'],
  ])('never holds %s', (_case, door, challenge) => {
    holdCode(door, challenge, 'spent');
    expect(heldCode(door, challenge)).toBeNull();
  });

  it('is dropped whole on lock or exit', () => {
    holdCode(HOME, 'c_1', 'spent');
    holdCode(OTHER, 'c_2', 'expired');
    clearHeldCodes();
    expect(heldCode(HOME, 'c_1')).toBeNull();
    expect(heldCode(OTHER, 'c_2')).toBeNull();
  });
});
