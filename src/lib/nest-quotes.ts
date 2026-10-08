/**
 * Review quotes render inside curly double quotes, so a quote that itself
 * quotes a title ("Kramer/Fauci" is the most beautiful show...) showed a
 * doubled mark. Nested quotations take single quotes (BRO-4881).
 * Only paired marks are converted; a stray unpaired quote is left alone.
 */
export function nestQuotes(text: string): string {
  return text.replace(/["\u201C]([^"\u201C\u201D]+)["\u201D]/g, '\u2018$1\u2019');
}
