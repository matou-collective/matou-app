/**
 * Unit tests for the @-mention typeahead's Slack-style matcher (issue #37).
 *
 * The composable itself reads Pinia stores; this covers the pure matching rule
 * that decides which candidates survive a query — including the carry-over fix
 * that a query spanning a space (`@Andrew W`, `@Fix login`) keeps matching.
 */
import { describe, it, expect } from 'vitest';
import { mentionQueryMatches } from '../../src/lib/mentions';

describe('mentionQueryMatches', () => {
  it('matches a single-token substring, case-insensitively', () => {
    expect(mentionQueryMatches('Andrew Weaver', 'and')).toBe(true);
    expect(mentionQueryMatches('Andrew Weaver', 'WEAV')).toBe(true);
    expect(mentionQueryMatches('Andrew Weaver', 'xyz')).toBe(false);
  });

  it('matches across a space (the carry-over bug)', () => {
    expect(mentionQueryMatches('Andrew Weaver', 'Andrew W')).toBe(true);
    expect(mentionQueryMatches('Fix login flow', 'fix login')).toBe(true);
    expect(mentionQueryMatches('Fix login flow', 'login flow')).toBe(true);
  });

  it('requires every token to appear (order-independent)', () => {
    expect(mentionQueryMatches('Fix login flow', 'flow fix')).toBe(true);
    expect(mentionQueryMatches('Fix login flow', 'fix logout')).toBe(false);
  });

  it('treats an empty or whitespace query as "match everything"', () => {
    expect(mentionQueryMatches('anything', '')).toBe(true);
    expect(mentionQueryMatches('anything', '   ')).toBe(true);
  });
});
