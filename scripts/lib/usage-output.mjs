// BRO-7790: output that is only a usage/help banner is not a run. Shared by the session Stop check
// (live-run-stop.mjs) and the daily landed-change proof audit (landed-change-proof.mjs). No I/O, no imports, so
// the CI audit does not pull in the Stop hook's transcript readers.
const BANNER_LINE_RE = /^\s*(?:usage\b|options:|flags:|commands:|examples?:|arguments:|node\s|npx\s|-{1,2}\w)/i;

/**
 * PURE. True when the output opens with a usage line and every other non-blank line is banner text: an indented line,
 * an option line, or a section header. A real run that prints "usage" somewhere in its report is not a banner.
 */
export function isUsageOnlyOutput(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length || lines.length > 60) return false;
  if (!/^\s*usage\b/i.test(lines[0]) && !/^\s*usage\b/i.test(lines[1] || '')) return false;
  return lines.every((l, i) => (i === 0) || BANNER_LINE_RE.test(l) || /^\s{2,}\S/.test(l) || /^\s*usage\b/i.test(l));
}
