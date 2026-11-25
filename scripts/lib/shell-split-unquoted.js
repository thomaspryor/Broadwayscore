'use strict';
// Shared command splitter for the review gates (BRO-8095). A plain regex split on the shell separators
// cut a command at a `|` inside quotes (`--test-name-pattern='a|b'`, `grep 'a|b' f`, `echo 'x | node --test f'`), which both refused real
// runs and credited an echoed string as a run. Use this instead of a raw regex split wherever a gate judges a command.

/**
 * Split on && || ; | that sit OUTSIDE '...' and "..." (a `|` in `--test-name-pattern='a|b'` is not a pipe; BRO-8095).
 * opts (default off, so the default is unchanged): `pipe:false` leaves a single `|` in the segment (`||` still splits), `newline:true` also splits on \n, `background:true` also splits on a lone `&`.
 * A backslash escapes the next char outside single quotes. A quote that never closes (an apostrophe in a `# it's`
 * comment) is treated as a plain character and the scan restarts, so one stray apostrophe neither swallows the later
 * `&&` nor re-opens the split-inside-quotes hole for an `echo 'x | node --test f'` (ship-check, 3 reviewers).
 */
function splitUnquoted(t, opts) {
  const { pipe = true, newline = false, background = false } = opts || {};
  const literal = new Set();
  for (;;) {
    let open = -1;
    const out = [];
    let cur = '';
    let q = '';
    let qAt = -1;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && q !== "'") { cur += c + (t[i + 1] || ''); i++; continue; }
      if (q) { if (c === q) q = ''; cur += c; continue; }
      if ((c === "'" || c === '"') && !literal.has(i)) { q = c; qAt = i; cur += c; continue; }
      const lone = c === '&' && t[i + 1] !== '&' && t[i - 1] !== '&';
      if (c === ';' || (c === '|' && (pipe || t[i + 1] === '|')) || (c === '&' && t[i + 1] === '&') || (newline && c === '\n') || (background && lone)) {
        if ((c === '|' || c === '&') && t[i + 1] === c) i++;
        out.push(cur); cur = '';
        continue;
      }
      cur += c;
    }
    if (q) open = qAt;
    if (open === -1) { out.push(cur); return out; }
    literal.add(open);
  }
}

module.exports = { splitUnquoted };
