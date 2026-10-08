/**
 * Review quotes render inside curly double quotes, so quote marks that are
 * already in the stored text showed up doubled (BRO-4881):
 *   - a quote wrapped in its own marks:  “"Gold's invigorating production..."”
 *   - a stray unmatched opening mark:    “"You will be thrilled...
 *   - a quoted title inside the quote:   “"Kramer/Fauci" is the most...”
 * The wrapper and stray marks are dropped; nested quotations take single
 * quotes, the standard style inside a double-quoted passage.
 */
const isOpen = (c: string | undefined) => c === '"' || c === '“';
const isClose = (c: string | undefined) => c === '"' || c === '”';

export function nestQuotes(text: string): string {
  let t = text.trim();
  const marks = (t.match(/["“”]/g) || []).length;
  if (marks === 2 && isOpen(t[0]) && isClose(t[t.length - 1])) {
    t = t.slice(1, -1);
  } else if (marks % 2 === 1) {
    if (isOpen(t[0])) t = t.slice(1);
    else if (isClose(t[t.length - 1])) t = t.slice(0, -1);
  }
  return t.replace(/["“]([^"“”]+)["”]/g, '‘$1’');
}
