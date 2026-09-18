import { describe, it, expect } from 'vitest';

import {
  parseDescriptor,
  hasContentLayer,
  schemaOobis,
  signinUrl,
  describeStackMismatch,
  UnsupportedDescriptorVersionError,
  KNOWN_DESCRIPTOR_MAJOR,
  BACKEND_KIND_IDSS,
} from 'src/lib/descriptor';

// The three GOLDEN documents are the fixtures idss's descriptor writer renders
// and checks in (idss internal/orgconfig/testdata) — one source, two repos
// (issue #533). The loader tests run against the very same bytes: a drift in
// the rendering reds idss's render_test and, once re-synced, reds here too, so
// a wallet never silently meets a shape idss stopped writing.
import goldenNoAnysync from './fixtures/descriptor/golden-no-anysync.json';
import goldenAnysync from './fixtures/descriptor/golden-anysync.json';
import goldenAppReady from './fixtures/descriptor/golden-app-ready.json';

describe('community backend descriptor loader (ADR 0226) — golden documents', () => {
  it('parses the no-any-sync golden document', () => {
    const d = parseDescriptor(goldenNoAnysync);
    expect(d.version).toBe('1.1');
    expect(d.backend_kind).toBe(BACKEND_KIND_IDSS);
    expect(d.community?.name).toBe('Whakatōhea');
    expect(d.community?.registry).toBe('ERegistrySAID0000000000000000000000000000000');
    expect(d.admins).toHaveLength(1);
    expect(d.admins[0]?.name).toBe('Ben Tairea');
    // any-sync absent — the content layer is not installed, and nothing throws.
    expect(d.anysync).toBeUndefined();
    expect(hasContentLayer(d)).toBe(false);
    // app absent until an app record reaches ready.
    expect(d.app).toBeUndefined();
  });

  it('parses the any-sync golden document (content layer installed)', () => {
    const d = parseDescriptor(goldenAnysync);
    expect(d.anysync).toBeDefined();
    expect(hasContentLayer(d)).toBe(true);
    expect(d.anysync?.network_id).toBe('N7whakatoheaAnysyncNetwork00000000000000000');
    // still no app block on this variant.
    expect(d.app).toBeUndefined();
  });

  it('parses the app-ready golden document', () => {
    const d = parseDescriptor(goldenAppReady);
    expect(hasContentLayer(d)).toBe(true);
    expect(d.app?.name).toBe('Whakatōhea');
    expect(d.app?.downloads_url).toBe('https://coa.matou.nz/c/whakatohea/downloads');
    expect(d.app?.platforms).toContain('Android');
  });

  it('takes schema OOBIs from the schemas block, not a built-in list', () => {
    const d = parseDescriptor(goldenNoAnysync);
    expect(d.schemas.membership?.oobi).toBe(
      'https://schema.whakatohea.idss.nz/oobi/EMembershipSchemaSAID00000000000000000000000',
    );
    expect(d.schemas.committee?.said).toBe('ECommitteeSchemaSAID000000000000000000000000');
    expect(schemaOobis(d).sort()).toEqual([
      'https://schema.whakatohea.idss.nz/oobi/ECommitteeSchemaSAID000000000000000000000000',
      'https://schema.whakatohea.idss.nz/oobi/EMembershipSchemaSAID00000000000000000000000',
    ]);
  });

  it('reads signin.url as the home community door', () => {
    const d = parseDescriptor(goldenNoAnysync);
    expect(signinUrl(d)).toBe('https://whakatohea.idss.nz/authz/signin');
  });

  it('surfaces a stack mismatch as a diagnostics warning, never a refusal', () => {
    const d = parseDescriptor(goldenNoAnysync);
    // The golden gateway pins signify 0.2.0-rc1; a wallet on a newer generation
    // gets a warning, not a thrown error.
    const warnings = describeStackMismatch(d, { keria: '0.4.0', signify: '0.3.0-rc2' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/signify/i);
    // No mismatch when the generations line up.
    expect(describeStackMismatch(d, { keria: '0.4.0', keripy: '1.2.6', signify: '0.2.0-rc1' })).toEqual([]);
  });
});

describe('community backend descriptor loader — tolerance and refusal', () => {
  it('tolerates an absent doorkeeper block (retired) and drops it', () => {
    // A gateway that still serves the retired doorkeeper block does not trip
    // the loader; the block is simply not read (ADR 0236).
    const d = parseDescriptor({
      ...goldenNoAnysync,
      doorkeeper: { aid: 'EDoorkeeper', oobi: 'https://x/oobi' },
    });
    expect(d.signin?.url).toBe('https://whakatohea.idss.nz/authz/signin');
    expect((d as Record<string, unknown>).doorkeeper).toBeUndefined();
  });

  it('accepts an additive minor bump (1.x) without refusing', () => {
    const d = parseDescriptor({ ...goldenNoAnysync, version: '1.9', futureBlock: { a: 1 } });
    expect(d.version).toBe('1.9');
    // Unknown blocks are simply not surfaced.
    expect((d as Record<string, unknown>).futureBlock).toBeUndefined();
  });

  it('refuses an unknown version major', () => {
    expect(() => parseDescriptor({ ...goldenNoAnysync, version: '2.0' })).toThrow(
      UnsupportedDescriptorVersionError,
    );
  });

  it('refuses a missing or unparseable version (treated as an unknown major)', () => {
    expect(() => parseDescriptor({ ...goldenNoAnysync, version: undefined })).toThrow(
      UnsupportedDescriptorVersionError,
    );
    expect(() => parseDescriptor({ ...goldenNoAnysync, version: 'garbage' })).toThrow(
      UnsupportedDescriptorVersionError,
    );
  });

  it('knows exactly one major', () => {
    expect(KNOWN_DESCRIPTOR_MAJOR).toBe(1);
  });

  it('throws a plain error on a non-object', () => {
    expect(() => parseDescriptor(null)).toThrow(/must be a JSON object/);
    expect(() => parseDescriptor('nope')).toThrow(/must be a JSON object/);
  });
});
