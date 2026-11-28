'use strict';
// BRO-5844: is a unified diff of ONE src/ code file text-only (no visual change)?
// Used by .claude/hooks/pre-push-visual-gate.sh to skip the owner-approval gate
// for copy edits. Fail closed: anything unrecognised counts as visual.
//
// Rule: walk each change block (consecutive removed lines then added lines).
// Drop strict prose lines and whole-line `//` comments, mask JSX text that sits
// directly between tags, then require the removed and added lines to match
// pairwise IN ORDER. Moves, swaps, added/removed code, block comments and
// string literals (can be style values) all keep the push gated.

// Text directly after a tag and before the next `<`, no code operators in it.
const JSX_TEXT_RE = /(<[A-Za-z][^<>{}]*>|<\/[A-Za-z][\w.]*>)([^<>{}=&|]+)(?=<)/g;
// Bare JSX prose: sentence-like (capitalised start or terminal punctuation),
// 2+ words, no code punctuation or quotes other than apostrophes.
const PROSE_CHARS_RE = /^[A-Za-z][A-Za-z0-9\s,.!?'’%$#@]*$/;
const KEYWORD_RE = /^(return|const|let|var|import|export|if|else|case|default|break|continue|await|throw|type|interface|function|async|new|typeof|from)\b/;

function isProseLine(s) {
  if (!PROSE_CHARS_RE.test(s) || KEYWORD_RE.test(s)) return false;
  if (!/\s/.test(s)) return false;
  return /^[A-Z]/.test(s) || /[.,!?]$/.test(s);
}
function isDroppable(line) {
  const s = line.trim();
  if (!s) return true;
  if (/^\/\/[^<>{}]*$/.test(s)) return true;
  return isProseLine(s);
}
function maskLine(line) {
  return line.replace(JSX_TEXT_RE, '$1$3').trim().replace(/\s+/g, ' ');
}

function blockIsTextOnly(removed, added) {
  const r = removed.filter((l) => !isDroppable(l)).map(maskLine);
  const a = added.filter((l) => !isDroppable(l)).map(maskLine);
  return r.length === a.length && r.every((l, i) => l === a[i]);
}

function isTextOnlyDiff(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return false;
  if (/^(new file mode|deleted file mode|rename from|Binary files|--- \/dev\/null|\+\+\+ \/dev\/null)/m.test(patch)) return false;
  if (!/^@@ /m.test(patch)) return false;
  let inHunk = false;
  let removed = [];
  let added = [];
  const flush = () => {
    const ok = blockIsTextOnly(removed, added);
    removed = []; added = [];
    return ok;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { if (!flush()) return false; inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) {
      if (added.length && !removed.length) { /* new block starts */ }
      if (added.length) { if (!flush()) return false; }
      removed.push(line.slice(1));
    } else if (!flush()) return false;
  }
  return flush();
}

module.exports = { isTextOnlyDiff, maskLine, filterFiles };

function filterFiles(range, files, run) {
  // Keep every file that is not provably a text-only src code edit (fail closed).
  return files.filter((f) => {
    if (!/^src\/.*\.(tsx|jsx|ts|js)$/.test(f)) return true;
    try { return !isTextOnlyDiff(run(range, f)); } catch { return true; }
  });
}

if (require.main === module && process.argv[2] === '--filter') {
  const { execFileSync } = require('child_process');
  const files = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const run = (range, f) => execFileSync('git', ['diff', range, '--', f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  process.stdout.write(filterFiles(process.argv[3], files, run).map((f) => f + '\n').join(''));
} else if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => {
    let ok = false;
    try { ok = isTextOnlyDiff(buf); } catch { ok = false; }
    process.exit(ok ? 0 : 1);
  });
}
