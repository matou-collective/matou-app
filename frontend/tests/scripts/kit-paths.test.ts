import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { kitUserDataDirName, kitUserDataPath } from '../../src-electron/kit-paths';

describe('kit userData path derivation (#344)', () => {
  it('keeps stock Matou on the existing ~/.config/Matou path', () => {
    const stock = JSON.parse(readFileSync(join(__dirname, '../../kit.build.json'), 'utf8'));
    expect(stock.productName).toBe('Matou'); // guards the no-orphan invariant
    expect(kitUserDataDirName(stock)).toBe('Matou');
    expect(kitUserDataPath('/home/u/.config', stock)).toBe('/home/u/.config/Matou');
  });

  it('gives a branded kit its own userData root, isolated from stock', () => {
    const branded = { productName: 'Matou Smoke' };
    expect(kitUserDataDirName(branded)).toBe('Matou Smoke');
    expect(kitUserDataPath('/home/u/.config', branded)).toBe('/home/u/.config/Matou Smoke');
    expect(kitUserDataPath('/home/u/.config', branded)).not.toBe(
      kitUserDataPath('/home/u/.config', { productName: 'Matou' }),
    );
  });

  it('falls back to Matou (never a bare appData root) for a blank productName', () => {
    expect(kitUserDataDirName({ productName: '   ' })).toBe('Matou');
    expect(kitUserDataPath('/home/u/.config', { productName: '' })).toBe('/home/u/.config/Matou');
  });
});
