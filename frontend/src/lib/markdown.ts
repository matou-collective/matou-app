/**
 * Shared markdown rendering for user-authored text (chat messages,
 * contribution reports, comments).
 *
 * Two concerns are kept separate so the link-parsing behaviour can be unit
 * tested without a DOM:
 *   - `markdownToHtml` turns markdown/plain text into HTML with GFM
 *     autolinking, so both markdown-style links and bare URLs become
 *     `<a href>` tags. Pure — no DOM required.
 *   - `renderMarkdown` sanitises that HTML for safe `v-html` rendering and
 *     forces links to open in a new context (`target="_blank"`), which the
 *     Electron main process intercepts to open the OS default browser.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Force external targeting on anchors so links open outside the SPA:
// in the browser this opens a new tab; in Electron `setWindowOpenHandler`
// routes it to the OS default browser via `shell.openExternal`.
// Guarded because DOMPurify only has a working instance (and `addHook`) when
// a DOM is present — in a plain-node context (unit tests) it is a no-op stub.
if (typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Render markdown/plain text to HTML. Bare URLs autolink via GFM, so pasted
 * links become clickable even when the author didn't use markdown syntax.
 * Does not sanitise — callers must pass the result through `renderMarkdown`
 * (or DOMPurify) before inserting into the DOM.
 */
export function markdownToHtml(text: string | null | undefined): string {
  if (!text) return '';
  return marked.parse(text, { gfm: true, breaks: true }) as string;
}

/**
 * Sanitise an HTML string for safe `v-html` rendering. Anchors are forced to
 * open externally (see the hook above); other elements keep DOMPurify's safe
 * defaults, which pass through the `<span class="mention-chip" data-mention-*>`
 * markup the chat mention renderer emits.
 */
export function sanitizeHtml(html: string): string {
  // DOMPurify only has a working `sanitize` when a DOM is present. In a
  // plain-node context (unit tests) it is unavailable — return the HTML
  // as-is, mirroring the guarded `addHook` above. Production always runs in
  // the Electron renderer / browser where a DOM exists.
  if (typeof DOMPurify.sanitize !== 'function') return html;
  return DOMPurify.sanitize(html);
}

/**
 * Render user-authored text to sanitised HTML safe for `v-html`.
 */
export function renderMarkdown(text: string | null | undefined): string {
  return sanitizeHtml(markdownToHtml(text));
}
