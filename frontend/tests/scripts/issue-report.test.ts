import { describe, it, expect } from 'vitest';
import {
  buildIssuePayload,
  summarizePlatform,
  TITLE_MAX,
  DESCRIPTION_MAX,
} from '../../src/lib/issueReport';

const CONTEXT = {
  appVersion: '0.3.0',
  platform: 'Electron on X11; Linux x86_64',
  env: 'dev',
  reporter: 'Ben',
};

describe('buildIssuePayload', () => {
  it('trims fields and appends a context table after a separator', () => {
    const p = buildIssuePayload(
      { type: 'bug', title: '  Crash on login  ', description: '  It crashed.  ' },
      CONTEXT,
    );
    expect(p.type).toBe('bug');
    expect(p.title).toBe('Crash on login');
    expect(p.body).toContain('It crashed.');
    expect(p.body).toContain('| App version | 0.3.0 |');
    expect(p.body).toContain('| Platform | Electron on X11; Linux x86_64 |');
    expect(p.body).toContain('| Environment | dev |');
    expect(p.body).toContain('| Reporter | Ben |');
    expect(p.body.indexOf('It crashed.')).toBeLessThan(p.body.indexOf('---'));
  });

  it('accepts the improvement type', () => {
    const p = buildIssuePayload(
      { type: 'improvement', title: 'Dark mode', description: 'Please add it.' },
      CONTEXT,
    );
    expect(p.type).toBe('improvement');
  });

  it('rejects empty or whitespace-only title and description', () => {
    expect(() =>
      buildIssuePayload({ type: 'bug', title: '   ', description: 'x' }, CONTEXT),
    ).toThrow(/title/i);
    expect(() =>
      buildIssuePayload({ type: 'bug', title: 'x', description: '  ' }, CONTEXT),
    ).toThrow(/description/i);
  });

  it('rejects over-length fields', () => {
    expect(() =>
      buildIssuePayload(
        { type: 'bug', title: 'a'.repeat(TITLE_MAX + 1), description: 'x' },
        CONTEXT,
      ),
    ).toThrow(/title/i);
    expect(() =>
      buildIssuePayload(
        { type: 'bug', title: 'x', description: 'a'.repeat(DESCRIPTION_MAX + 1) },
        CONTEXT,
      ),
    ).toThrow(/description/i);
  });

  it('rejects unknown types', () => {
    expect(() =>
      buildIssuePayload(
        { type: 'feature' as never, title: 'x', description: 'y' },
        CONTEXT,
      ),
    ).toThrow(/type/i);
  });
});

describe('summarizePlatform', () => {
  it('detects Electron and extracts the OS parenthetical', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/28.1.0 Safari/537.36';
    expect(summarizePlatform(ua)).toBe('Electron on X11; Linux x86_64');
  });

  it('labels non-Electron agents as Web', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    expect(summarizePlatform(ua)).toBe('Web on Macintosh; Intel Mac OS X 10_15_7');
  });

  it('falls back to unknown for empty/odd agents', () => {
    expect(summarizePlatform('')).toBe('Web on unknown');
  });
});
