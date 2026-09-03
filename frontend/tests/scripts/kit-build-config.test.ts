import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { electronBuilderConfig } from '../../src-electron/kit-builder-config';

describe('electron-builder config from kit.build.json', () => {
  it('maps the default kit to upstream values', () => {
    const c = electronBuilderConfig(JSON.parse(readFileSync(join(__dirname, '../../kit.build.json'), 'utf8')));
    expect(c.appId).toBe('org.matou.app');
    expect(c.productName).toBe('Matou'); // diacritic-folded by apply-kit — packaging name must stay ASCII (userData path!)
    expect(c.artifactName).toBe('matou-${version}-${os}.${ext}');
    expect(c.mac.artifactName).toBe('matou-${version}-${os}-${arch}.${ext}');
    expect(c.linux.executableName).toBe('matou');
    expect(c.publish).toEqual([{ provider: 'github', owner: 'matou-collective', repo: 'matou-app', releaseType: 'draft' }]);
  });
  it('maps a community kit to coa values and publish null', () => {
    const c = electronBuilderConfig({ appId: 'org.matou.coa.x-y', productName: 'X Y', artifactBase: 'x-y', executableName: 'x-y', androidApplicationId: 'org.matou.coa.x-y', urlScheme: 'org.matou.coa.x-y', publish: null, updates: false, primaryColour: '#000000', backgroundColour: '#000000' });
    expect(c.publish).toBeNull();
    expect(c.artifactName).toBe('x-y-${version}-${os}.${ext}');
  });
});
