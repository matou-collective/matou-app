import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../../src/lib/markdown';

describe('markdownToHtml', () => {
  it('autolinks bare URLs so pasted links become clickable', () => {
    const html = markdownToHtml('see https://matou.nz for details');
    expect(html).toContain('href="https://matou.nz"');
    expect(html).toContain('</a>');
  });

  it('renders markdown-style links as anchors', () => {
    const html = markdownToHtml('[the site](https://matou.nz)');
    expect(html).toContain('href="https://matou.nz"');
    expect(html).toContain('>the site</a>');
  });

  it('autolinks multiple URLs in one block of text', () => {
    const html = markdownToHtml('http://a.example.com and http://b.example.com');
    expect(html).toContain('href="http://a.example.com"');
    expect(html).toContain('href="http://b.example.com"');
  });

  it('leaves plain text without links untouched by anchor tags', () => {
    const html = markdownToHtml('just some plain text');
    expect(html).not.toContain('<a ');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
    expect(markdownToHtml(undefined)).toBe('');
  });
});
