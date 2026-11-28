'use strict';
/**
 * BRO-7458: pure scanner for scripts/audit-unguarded-git-network-timeout.js (rule 15: the test
 * require()s this, never a copy).
 *
 * Flags a synchronous git fetch/pull/clone that carries a `timeout` but does not go through
 * scripts/lib/git-proc-guard.js (runGit / runGitOrThrow). On timeout node kills only the direct
 * child; the fetch's index-pack is reparented to pid 1 and keeps writing a multi-GB tmp_pack.
 * Waive a reviewed line with `git-net-timeout-ok: <reason>` on that line or the one above.
 */

const NET = /^(fetch|pull|clone)$/;
const CALL = /\b(spawnSync|execFileSync)\(\s*['"`]git['"`]\s*,\s*\[/g;
// A wrapper passing its args through (`execFileSync('git', args, { timeout })`): it cannot be told
// whether a caller hands it a fetch, so it must route through runGit/runGitOrThrow or be waived.
const IDENT_CALL = /\b(spawnSync|execFileSync)\(\s*['"`]git['"`]\s*,\s*(?:\.\.\.)?[A-Za-z_$][\w$.]*\s*[,)]/g;
const SHELL_CALL = /\bexecSync\(\s*['"`]git\s+(?:-\S+\s+(?:\S+\s+)?)*?(fetch|pull|clone)\b/g;
const WAIVER = /git-net-timeout-ok:/;

/** Index just past the bracket/paren that closes the one opened at `open` (string-aware enough for args). */
function closeOf(text, open) {
  const pairs = { '[': ']', '(': ')', '{': '}' };
  const stack = [];
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return text.length;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** -> [{ line, call, snippet }] for one file's text. */
function scanText(text) {
  const out = [];
  const lines = text.split('\n');
  const waived = (line) => WAIVER.test(lines[line - 1] || '') || WAIVER.test(lines[line - 2] || '');
  for (const m of text.matchAll(CALL)) {
    const callOpen = m.index + m[0].indexOf('(');
    const end = closeOf(text, callOpen);
    const call = text.slice(m.index, end);
    const arrOpen = m.index + m[0].length - 1;
    const arr = text.slice(arrOpen, closeOf(text, arrOpen));
    const literals = [...arr.matchAll(/['"`]([^'"`]*)['"`]/g)].map((x) => x[1]);
    if (!literals.some((l) => NET.test(l))) continue;
    if (!/\btimeout\b/.test(call.slice(arr.length))) continue;
    const line = lineOf(text, m.index);
    if (!waived(line)) out.push({ line, call: m[1], snippet: lines[line - 1].trim().slice(0, 140) });
  }
  for (const m of text.matchAll(IDENT_CALL)) {
    const call = text.slice(m.index, closeOf(text, m.index + m[0].indexOf('(')));
    // Known limit: a timeout that arrives only through an options spread (`{ ...opts }`) is not seen;
    // flagging every spread wrapper hits ~8 local-only helpers. Network callers go through runGit.
    if (!/\btimeout\b/.test(call)) continue;
    const line = lineOf(text, m.index);
    if (!waived(line)) out.push({ line, call: m[1], snippet: lines[line - 1].trim().slice(0, 140), wrapper: true });
  }
  for (const m of text.matchAll(SHELL_CALL)) {
    const callOpen = m.index + m[0].indexOf('(');
    const call = text.slice(m.index, closeOf(text, callOpen));
    if (!/\btimeout\b/.test(call)) continue;
    const line = lineOf(text, m.index);
    if (!waived(line)) out.push({ line, call: 'execSync', snippet: lines[line - 1].trim().slice(0, 140) });
  }
  return out;
}

/** files: [{ file, text }] -> [{ file, line, call, snippet }] */
function scanFiles(files) {
  return files.flatMap(({ file, text }) => scanText(text).map((h) => ({ file, ...h })));
}

module.exports = { scanText, scanFiles };
