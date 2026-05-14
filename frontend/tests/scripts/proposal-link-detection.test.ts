/**
 * Unit tests for proposal link detection in chat messages.
 * Tests the regex extraction of proposal IDs from message content.
 */
import { describe, it, expect } from 'vitest';

/** Extract unique proposal IDs from message content (mirrors MessageItem.vue logic). */
function extractProposalIds(content: string): string[] {
  const regex = /\/dashboard\/proposals\/(prop_[a-f0-9]+)/g;
  const ids = new Set<string>();
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

describe('Proposal link detection', () => {
  it('extracts a single proposal ID from a full URL', () => {
    const content = 'Check this out: http://localhost:5100/dashboard/proposals/prop_56c0dff5672fecc3';
    expect(extractProposalIds(content)).toEqual(['prop_56c0dff5672fecc3']);
  });

  it('extracts a proposal ID from a path-only link', () => {
    const content = 'See /dashboard/proposals/prop_abc123def456';
    expect(extractProposalIds(content)).toEqual(['prop_abc123def456']);
  });

  it('extracts multiple different proposal IDs', () => {
    const content =
      'Compare /dashboard/proposals/prop_aaaa1111bbbb2222 ' +
      'with /dashboard/proposals/prop_cccc3333dddd4444';
    const ids = extractProposalIds(content);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('prop_aaaa1111bbbb2222');
    expect(ids).toContain('prop_cccc3333dddd4444');
  });

  it('deduplicates repeated proposal IDs', () => {
    const content =
      '/dashboard/proposals/prop_aaaa1111bbbb2222 and again ' +
      '/dashboard/proposals/prop_aaaa1111bbbb2222';
    expect(extractProposalIds(content)).toEqual(['prop_aaaa1111bbbb2222']);
  });

  it('returns empty array when no proposal links are present', () => {
    expect(extractProposalIds('Hello everyone!')).toEqual([]);
    expect(extractProposalIds('Check /dashboard/chat for updates')).toEqual([]);
    expect(extractProposalIds('')).toEqual([]);
  });

  it('ignores URLs that do not match the proposal pattern', () => {
    expect(extractProposalIds('/dashboard/proposals/')).toEqual([]);
    expect(extractProposalIds('/dashboard/proposals/123')).toEqual([]);
    expect(extractProposalIds('/dashboard/proposals/prop_UPPER')).toEqual([]);
  });

  it('extracts proposal ID embedded in markdown link', () => {
    const content = '[My Proposal](http://localhost:9000/dashboard/proposals/prop_deadbeef12345678)';
    expect(extractProposalIds(content)).toEqual(['prop_deadbeef12345678']);
  });

  it('extracts proposal ID from multiline content', () => {
    const content = `Hey team,
Please review this proposal:
http://localhost:5100/dashboard/proposals/prop_aabbccddee112233
Let me know what you think.`;
    expect(extractProposalIds(content)).toEqual(['prop_aabbccddee112233']);
  });

  it('handles mixed content with proposals and other links', () => {
    const content =
      'See https://example.com/docs and ' +
      'http://localhost:5100/dashboard/proposals/prop_ff00ff00ff00ff00 ' +
      'and also /dashboard/chat';
    expect(extractProposalIds(content)).toEqual(['prop_ff00ff00ff00ff00']);
  });
});
