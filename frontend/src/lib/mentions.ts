/**
 * In-chat @-mentions (issue #12).
 *
 * Messages stay plain text. A mention is stored inline as a token of the form
 *   `@[type:id|Display Name]`
 * e.g. `@[person:EAbc…|Andrew Weaver]`. The display name is embedded at send
 * time so historical messages render sensibly even if the entity is later
 * renamed or deleted.
 *
 * This module is the shared machinery: the token format, a parser, and a
 * renderer that turns tokens into clickable chips — generalizing the existing
 * `MessageItem.vue` URL-regex → link-card pattern rather than introducing
 * rich-text composer state. The first PR wires the `person` type end-to-end;
 * the renderer already handles all six types so a follow-up only adds the
 * typeahead search and click behaviour for the rest.
 */
import { markdownToHtml, sanitizeHtml } from './markdown';

export type MentionType =
  | 'person'
  | 'project'
  | 'proposal'
  | 'event'
  | 'update'
  | 'contribution';

export const MENTION_TYPES: readonly MentionType[] = [
  'person',
  'project',
  'proposal',
  'event',
  'update',
  'contribution',
];

export interface Mention {
  type: MentionType;
  id: string;
  display: string;
}

/** Split a typeahead query into lowercased match tokens; empty → no tokens. */
export function mentionQueryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every token appears somewhere in `display` (case-insensitive). */
export function displayMatchesTokens(display: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = display.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Slack-style match for the @-mention typeahead: every whitespace-separated
 * token in `query` must appear (case-insensitively) somewhere in `display`, so
 * a query that spans a space — `@Andrew W`, `@Fix login` — keeps matching. An
 * empty query matches everything so the dropdown fills the moment `@` is typed.
 */
export function mentionQueryMatches(display: string, query: string): boolean {
  return displayMatchesTokens(display, mentionQueryTokens(query));
}

// Matches `@[type:id|Display Name]`. The id excludes `|`, `]` and whitespace;
// the display excludes `]`. The alternation pins `type` to the valid set so
// unrelated `@[...]` text is left untouched.
const TYPE_ALT = MENTION_TYPES.join('|');
export const MENTION_TOKEN_RE = new RegExp(
  `@\\[(${TYPE_ALT}):([^|\\]\\s]+)\\|([^\\]]+)\\]`,
  'g',
);

/**
 * Build a mention token for storage. The display name is stripped of the few
 * characters that would break the token grammar (`|`, `]`, newlines).
 */
export function serializeMention(type: MentionType, id: string, display: string): string {
  const safeDisplay = display.replace(/[|\]\r\n]/g, ' ').trim() || id;
  return `@[${type}:${id}|${safeDisplay}]`;
}

/** Extract every mention token from a message, in order of appearance. */
export function parseMentions(text: string | null | undefined): Mention[] {
  if (!text) return [];
  const out: Mention[] = [];
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ type: m[1] as MentionType, id: m[2], display: m[3] });
  }
  return out;
}

/**
 * Collapse mention tokens to their `@Display Name` text. For plain-text
 * previews (reply previews, thread snippets) where chips can't be rendered.
 */
export function mentionsToPlainText(text: string | null | undefined): string {
  if (!text) return '';
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  return text.replace(re, (_full, _type, _id, display) => `@${display}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML for a single clickable mention chip. */
function mentionChipHtml(m: Mention): string {
  return (
    `<span class="mention-chip" data-mention-type="${escapeHtml(m.type)}" ` +
    `data-mention-id="${escapeHtml(m.id)}" role="button" tabindex="0">` +
    `@${escapeHtml(m.display)}</span>`
  );
}

/**
 * Render a chat message to sanitised HTML safe for `v-html`, with mention
 * tokens turned into clickable chips and everything else rendered as markdown
 * (bare URLs autolink, same as {@link renderMarkdown}).
 *
 * Tokens are swapped for opaque placeholders before markdown parsing so the
 * markdown engine can't mangle the `@[...]` grammar or the embedded display
 * name; the placeholders are then replaced with chip HTML and the whole thing
 * sanitised in one pass (chip `<span>`s survive DOMPurify's defaults).
 *
 * Placeholders that land inside a `<code>`/`<pre>` block are restored to the
 * author's literal `@[...]` token text instead of becoming chips, so the chat
 * can quote its own mention syntax in backticks without it turning clickable.
 */
export function renderMessageContent(text: string | null | undefined): string {
  if (!text) return '';

  const mentions: (Mention & { raw: string })[] = [];
  // Per-call random nonce so message text can never forge (or collide with)
  // a placeholder: a pasted literal sentinel would duplicate or delete chips.
  const nonce = Math.random().toString(36).slice(2, 10);
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  const withPlaceholders = text.replace(re, (full, type, id, display) => {
    const idx = mentions.length;
    mentions.push({ type: type as MentionType, id, display, raw: full });
    // Wrapped in sentinels markdown can't interpret as markdown syntax.
    return `⁣MENTION${nonce}-${idx}⁣`;
  });

  const placeholderRe = new RegExp(`⁣MENTION${nonce}-(\\d+)⁣`, 'g');
  // Alternation: a whole `<pre>`/`<code>` block, OR a bare placeholder. Inside
  // a code block, placeholders are swapped back to the escaped literal token;
  // elsewhere they become chips. The `<pre>` branch comes first so a
  // `<pre><code>` fence is consumed whole, not split at its inner `<code>`.
  const codeOrPlaceholder = new RegExp(
    `(<pre[\\s\\S]*?</pre>|<code[\\s\\S]*?</code>)|⁣MENTION${nonce}-(\\d+)⁣`,
    'g',
  );

  let html = markdownToHtml(withPlaceholders);
  html = html.replace(codeOrPlaceholder, (full, codeBlock, phIdx) => {
    if (codeBlock !== undefined) {
      return codeBlock.replace(placeholderRe, (ph: string, i: string) => {
        const m = mentions[Number(i)];
        return m ? escapeHtml(m.raw) : ph;
      });
    }
    const m = mentions[Number(phIdx)];
    // Leave the original placeholder visible rather than silently deleting it
    // if the index somehow doesn't resolve.
    return m ? mentionChipHtml(m) : full;
  });

  return sanitizeHtml(html);
}
