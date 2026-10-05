/**
 * Strips tool-call markup that leaked from the model into outbound text, e.g.
 * a trailing "</parameter>" or a whole "<function_calls>...</function_calls>"
 * block, before it reaches a user (2026-10-04 Daniela's dist filter, ported to
 * src 2026-10-05 so a rebuild keeps it). Only exact tool tags are touched; any
 * other text, including normal "<" / ">" usage, is left as is.
 */
const TAGS = '(?:parameter|invoke|function_calls|function_results)';
// A complete leaked block: drop the tags AND what is between them.
const LEAKED_BLOCK = new RegExp(`<(?:antml:)?(function_calls|function_results)\\b[^>]*>[\\s\\S]*?</(?:antml:)?\\1>`, 'gi');
// Any remaining stray opening/closing tool tag.
const LEAKED_TAG = new RegExp(`</?(?:antml:)?${TAGS}\\b[^>]*>`, 'gi');

export function sanitizeOutboundText(text: unknown): { text: unknown; stripped: boolean } {
  if (typeof text !== 'string' || !new RegExp(LEAKED_TAG.source, 'i').test(text)) return { text, stripped: false };
  const clean = text
    .replace(LEAKED_BLOCK, '')
    .replace(LEAKED_TAG, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: clean, stripped: clean !== text };
}

/** Mutates content in place (text + caption); returns whether anything was removed. */
export function sanitizeOutboundContent(content: Record<string, unknown> | null | undefined): {
  content: Record<string, unknown> | null | undefined;
  stripped: boolean;
} {
  if (!content || typeof content !== 'object') return { content, stripped: false };
  let stripped = false;
  for (const key of ['text', 'caption']) {
    const r = sanitizeOutboundText(content[key]);
    if (r.stripped) {
      content[key] = r.text;
      stripped = true;
    }
  }
  return { content, stripped };
}
