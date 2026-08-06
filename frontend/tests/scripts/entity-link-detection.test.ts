/**
 * Unit tests for project & contribution link detection in chat messages.
 * Tests the regex extraction of project/contribution IDs from message content
 * (mirrors the MessageItem.vue logic added for issue #11).
 */
import { describe, it, expect } from 'vitest';

/** Extract unique IDs matching a pattern from message content. */
function extractIds(content: string, pattern: RegExp): string[] {
  const ids = new Set<string>();
  let match;
  while ((match = pattern.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

const projectPattern = () => /\/dashboard\/projects\/(proj_[a-f0-9]+)/g;
const contributionPattern = () => /\/dashboard\/contributions\/(ctr_[a-f0-9]+)/g;

describe('Project link detection', () => {
  it('extracts a single project ID from a full URL', () => {
    const content = 'Have a look: http://localhost:9000/dashboard/projects/proj_56c0dff5672fecc3';
    expect(extractIds(content, projectPattern())).toEqual(['proj_56c0dff5672fecc3']);
  });

  it('extracts a project ID from a path-only link', () => {
    expect(extractIds('See /dashboard/projects/proj_abc123def456', projectPattern())).toEqual([
      'proj_abc123def456',
    ]);
  });

  it('extracts a project ID embedded in a markdown link', () => {
    const content = '[My Project](http://localhost:9000/dashboard/projects/proj_deadbeef12345678)';
    expect(extractIds(content, projectPattern())).toEqual(['proj_deadbeef12345678']);
  });

  it('deduplicates repeated project IDs', () => {
    const content =
      '/dashboard/projects/proj_aaaa1111 and again /dashboard/projects/proj_aaaa1111';
    expect(extractIds(content, projectPattern())).toEqual(['proj_aaaa1111']);
  });

  it('does not match proposal or contribution links', () => {
    expect(extractIds('/dashboard/proposals/prop_abc123', projectPattern())).toEqual([]);
    expect(extractIds('/dashboard/contributions/ctr_abc123', projectPattern())).toEqual([]);
  });

  it('ignores malformed project URLs', () => {
    expect(extractIds('/dashboard/projects/', projectPattern())).toEqual([]);
    expect(extractIds('/dashboard/projects/123', projectPattern())).toEqual([]);
    expect(extractIds('/dashboard/projects/proj_UPPER', projectPattern())).toEqual([]);
  });
});

describe('Contribution link detection', () => {
  it('extracts a single contribution ID from a full URL', () => {
    const content = 'Task: http://localhost:9000/dashboard/contributions/ctr_56c0dff5672fecc3';
    expect(extractIds(content, contributionPattern())).toEqual(['ctr_56c0dff5672fecc3']);
  });

  it('extracts a contribution ID from a path-only link', () => {
    expect(
      extractIds('See /dashboard/contributions/ctr_abc123def456', contributionPattern()),
    ).toEqual(['ctr_abc123def456']);
  });

  it('extracts multiple different contribution IDs', () => {
    const content =
      'Compare /dashboard/contributions/ctr_aaaa1111 ' +
      'with /dashboard/contributions/ctr_bbbb2222';
    const ids = extractIds(content, contributionPattern());
    expect(ids).toHaveLength(2);
    expect(ids).toContain('ctr_aaaa1111');
    expect(ids).toContain('ctr_bbbb2222');
  });

  it('does not match proposal or project links', () => {
    expect(extractIds('/dashboard/proposals/prop_abc123', contributionPattern())).toEqual([]);
    expect(extractIds('/dashboard/projects/proj_abc123', contributionPattern())).toEqual([]);
  });

  it('ignores malformed contribution URLs', () => {
    expect(extractIds('/dashboard/contributions/', contributionPattern())).toEqual([]);
    expect(extractIds('/dashboard/contributions/ctr_UPPER', contributionPattern())).toEqual([]);
  });

  it('returns empty array when no entity links are present', () => {
    expect(extractIds('Hello everyone!', contributionPattern())).toEqual([]);
    expect(extractIds('', contributionPattern())).toEqual([]);
  });
});
