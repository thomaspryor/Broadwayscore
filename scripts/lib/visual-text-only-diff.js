'use strict';
// BRO-5844: is a unified diff of ONE src/ code file text-only (no visual change)?
// Used by .claude/hooks/pre-push-visual-gate.sh to skip the owner-approval gate
// for copy edits. Fail closed: anything unrecognised counts as visual.
//
// Rule (no hint regex, so no drift against verify-edits.sh): mask JSX text and
// bare prose lines on every removed and added line, then compare the two
// sequences in order. Identical => only copy changed. String literals stay
// significant (they can be style values), so those edits stay gated.

const JSX_TEXT_RE = />[^<>{}]+</g;
// A bare line of JSX prose: starts with a letter, 2+ words, no code punctuation,
// no quotes, and not a statement keyword. Anything else counts as code.
const PROSE_RE = /^[A-Za-z][\w\s,.!?'\u2019&%$#@-]*\s[\w\s,.!?'\u2019&%$#@-]*$/;
const KEYWORD_RE = /^(return|const|let|var|import|export|if|else|case|default|break|continue|await|throw|type|interface|function|async|new|typeof|from)\b/;

function maskLine(line) {
  // String literals are NOT masked: `gap: '4'`, ternary branches and prop values
  // can all change layout. Only JSX text between tags and bare prose lines are copy.
  let s = line.replace(JSX_TEXT_RE, '><').trim();
  if (/^(\/\/|\/\*|\*)/.test(s)) return '';
  if (!s || (PROSE_RE.test(s) && !KEYWORD_RE.test(s))) return '';
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
