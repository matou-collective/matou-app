// @vitest-environment happy-dom
/**
 * Unit tests for in-chat @-mention machinery (issues #12, #37): the token
 * format, parser, plain-text collapse, and chip renderer.
 *
 * Runs under happy-dom so DOMPurify has a real DOM and `renderMessageContent`
 * exercises actual sanitisation rather than the fail-closed escape path.
 */
import { describe, it, expect } from 'vitest';
import {
  serializeMention,
  parseMentions,
  mentionsToPlainText,
  renderMessageContent,
  MENTION_TYPES,
} from '../../src/lib/mentions';

describe('serializeMention', () => {
  it('builds a person token in the @[type:id|Display] form', () => {
    expect(serializeMention('person', 'EAbc123', 'Andrew Weaver')).toBe(
      '@[person:EAbc123|Andrew Weaver]',
    );
  });

  it('strips characters that would break the token grammar from the display', () => {
    expect(serializeMention('person', 'EAbc', 'Weird ]|name\nhere')).toBe(
      '@[person:EAbc|Weird   name here]',
    );
  });

  it('falls back to the id when the display collapses to empty', () => {
    expect(serializeMention('contribution', 'ctr_1', ']]|')).toBe(
      '@[contribution:ctr_1|ctr_1]',
    );
  });
});

describe('parseMentions', () => {
  it('extracts a single mention', () => {
    expect(parseMentions('hi @[person:EAbc|Andrew Weaver] there')).toEqual([
      { type: 'person', id: 'EAbc', display: 'Andrew Weaver' },
    ]);
  });

  it('extracts multiple mentions of different types in order', () => {
    const text =
      'ping @[person:E1|Ada] about @[contribution:ctr_9|Fix login flow]';
    expect(parseMentions(text)).toEqual([
      { type: 'person', id: 'E1', display: 'Ada' },
      { type: 'contribution', id: 'ctr_9', display: 'Fix login flow' },
    ]);
  });

  it('ignores unknown types and malformed tokens', () => {
    expect(parseMentions('@[robot:x|Bender] and @[person:|NoId]')).toEqual([]);
  });

  it('returns an empty array for text without mentions', () => {
    expect(parseMentions('just a normal message')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
  });

  it('round-trips every valid type through serialize', () => {
    for (const type of MENTION_TYPES) {
      const token = serializeMention(type, `${type}_id`, `${type} name`);
      expect(parseMentions(token)).toEqual([
        { type, id: `${type}_id`, display: `${type} name` },
      ]);
    }
  });
});

describe('mentionsToPlainText', () => {
  it('collapses tokens to @Display for previews', () => {
    expect(
      mentionsToPlainText('hey @[person:EAbc|Andrew Weaver] look here'),
    ).toBe('hey @Andrew Weaver look here');
  });

  it('leaves plain text untouched', () => {
    expect(mentionsToPlainText('no mentions here')).toBe('no mentions here');
  });
});

describe('renderMessageContent', () => {
  it('renders a mention token as a clickable chip carrying type and id', () => {
    const html = renderMessageContent('hi @[person:EAbc123|Andrew Weaver]');
    expect(html).toContain('class="mention-chip"');
    expect(html).toContain('data-mention-type="person"');
    expect(html).toContain('data-mention-id="EAbc123"');
    expect(html).toContain('@Andrew Weaver');
  });

  it('still autolinks bare URLs alongside mentions', () => {
    const html = renderMessageContent(
      'see https://matou.nz cc @[person:E1|Ada]',
    );
    expect(html).toContain('href="https://matou.nz"');
    expect(html).toContain('class="mention-chip"');
  });

  it('escapes HTML in the embedded display name', () => {
    const html = renderMessageContent('@[person:E1|<img src=x onerror=1>]');
    expect(html).not.toContain('<img');
    expect(html).toContain('class="mention-chip"');
  });

  it('leaves an ordinary @word untouched (no chip)', () => {
    const html = renderMessageContent('email me @home please');
    expect(html).not.toContain('mention-chip');
  });

  it('returns empty string for empty input', () => {
    expect(renderMessageContent('')).toBe('');
    expect(renderMessageContent(null)).toBe('');
  });

  it('sanitises raw HTML in the message body via the real DOMPurify', () => {
    // With happy-dom, DOMPurify keeps the <img> element but strips the event
    // handler. The fail-closed no-DOM path would instead escape the whole tag
    // to `&lt;img…&gt;` — so a surviving `<img` proves the real sanitiser ran.
    const html = renderMessageContent('<img src=x onerror="alert(1)">');
    expect(html).toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('keeps a mention literal inside an inline code span (no chip)', () => {
    const html = renderMessageContent('the syntax is `@[person:E1|Ada]`');
    expect(html).toContain('<code>');
    expect(html).toContain('@[person:E1|Ada]');
    expect(html).not.toContain('mention-chip');
  });

  it('keeps a mention literal inside a fenced code block (no chip)', () => {
    const html = renderMessageContent('```\n@[person:E1|Ada]\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('@[person:E1|Ada]');
    expect(html).not.toContain('mention-chip');
  });

  it('renders a chip outside code while leaving one inside code literal', () => {
    const html = renderMessageContent(
      'compare `@[person:E1|Ada]` with @[person:E2|Bob]',
    );
    expect(html).toContain('data-mention-id="E2"');
    expect(html).not.toContain('data-mention-id="E1"');
    expect(html).toContain('@[person:E1|Ada]');
  });
});
