/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

export interface SanitizeOptions {
  /**
   * Replace every long dash used as punctuation (— em / – en / ― horizontal
   * bar) with a comma. Deterministic, zero-token enforcement of the pilot
   * persona's "no AI em-dash" rule on every outbound message. Off by default
   * so it never touches channels that don't want it (e.g. the owner's own bot).
   */
  stripLongDashes?: boolean;
}

export function sanitizeTelegramLegacyMarkdown(input: string, opts: SanitizeOptions = {}): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Long-dash filter (opt-in). Runs after code extraction so dashes inside
  // code/inline-code are preserved, and BEFORE the list-bullet rule below so a
  // separator like `- - -` isn't first mangled into a `• - -` bullet. Cases:
  //   1. A line that is only a separator — long dashes/dividers (— – ― ⎯) OR a
  //      markdown horizontal rule (---, ***, ___, incl. spaced `- - -`) — is
  //      dropped entirely, leaving the surrounding blank lines as the break.
  //   2. An inline long dash used as punctuation ("word — word", "word—word")
  //      becomes a comma; duplicate commas that result are collapsed.
  if (opts.stripLongDashes) {
    text = text.replace(/^[ \t]*[—–―⎯]+[ \t]*$/gm, '');
    text = text.replace(/^[ \t]*([-*_][ \t]?){3,}[ \t]*$/gm, '');
    text = text.replace(/[ \t]*[—–―⎯][ \t]*/g, ', ').replace(/,(\s*,)+/g, ',');
  }

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules (bare --- / *** / ___ lines). Normally to
  // a plain Unicode divider (the parser doesn't understand HR syntax and the
  // `*` / `_` chars would unbalance the delimiter counts below). But on channels
  // that strip long dashes, that divider reads as a long dash between paragraphs
  // — so collapse the HR to nothing and let the surrounding blank lines be the
  // break instead.
  // Match a whole line that is only a markdown horizontal rule: 3+ of - * _,
  // with optional single spaces between them (catches `---`, `***`, `___`,
  // and spaced variants like `- - -` / `* * *`).
  const hrReplacement = opts.stripLongDashes ? '' : '⎯⎯⎯';
  text = text.replace(/^[ \t]*([-*_][ \t]?){3,}[ \t]*$/gm, hrReplacement);

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  const starCount = (text.match(/\*/g) ?? []).length;
  const underCount = (text.match(/_/g) ?? []).length;
  if (starCount % 2 !== 0 || underCount % 2 !== 0) {
    text = text.replace(/[*_]/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  // Dropping separator/HR lines can leave 3+ consecutive newlines; collapse to
  // a single blank line so paragraphs stay cleanly spaced. Code is placeholdered
  // so multi-blank lines inside code blocks are untouched.
  if (opts.stripLongDashes) {
    text = text.replace(/\n{3,}/g, '\n\n');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
