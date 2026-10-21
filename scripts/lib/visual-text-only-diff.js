'use strict';
// BRO-5844: is a unified diff of ONE src/ code file text-only (no visual change)?
// Used by .claude/hooks/pre-push-visual-gate.sh to skip the owner-approval gate
// for copy edits. Fail closed: anything unrecognised counts as visual.
//
// Rule (no hint regex, so no drift against verify-edits.sh): mask string
// literals and JSX text on every removed and added line, then compare the two
// sequences in order. Identical => only copy changed.

const STRING_RE = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\\n])*`/g;
const JSX_TEXT_RE = />[^<>{}]+</g;
const STYLE_LINE_RE = /class|\bcn\(|clsx|style|\bsx\b|variant|size|color|\btw`/i;
const CODE_TOKEN_RE = /[<>{}()=[\];:,?&|+*\/-]/;

function maskLine(line) {
  // Strings are copy EXCEPT attribute values (`size="lg"`) and anything on a
  // line that can carry styling (className/cn()/clsx/style/variant/size).
  const keepStrings = STYLE_LINE_RE.test(line);
  let s = line
    .replace(STRING_RE, (m, off, whole) => (keepStrings || /=\s*$/.test(whole.slice(0, off)) ? m : '""'))
    .replace(JSX_TEXT_RE, '><')
    .trim();
  if (/^(\/\/|\/\*|\*)/.test(s)) return '';
  if (!CODE_TOKEN_RE.test(s)) return ''; // bare prose line inside JSX
  return s.replace(/\s+/g, ' ');
}

function isTextOnlyDiff(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return false;
  if (/^(new file mode|deleted file mode|rename from|Binary files|--- \/dev\/null|\+\+\+ \/dev\/null)/m.test(patch)) return false;
  if (!/^@@ /m.test(patch)) return false;
  const removed = [];
  const added = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(maskLine(line.slice(1)));
    else if (line.startsWith('-')) removed.push(maskLine(line.slice(1)));
  }
  const a = removed.filter(Boolean);
  const b = added.filter(Boolean);
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

module.exports = { isTextOnlyDiff, maskLine };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => {
    let ok = false;
    try { ok = isTextOnlyDiff(buf); } catch { ok = false; }
    process.exit(ok ? 0 : 1);
  });
}
