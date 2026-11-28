/**
 * Lint: `echo "$VAR" | grep -q …` in a shell script that runs with pipefail.
 *
 * grep -q exits on its first match. If the text being echoed is larger than
 * the pipe buffer (~64 KB), echo is still writing, gets SIGPIPE, and under
 * `set -o pipefail` the pipeline's status becomes 141: the `if` reads it as
 * "no match". scripts/hooks/pre-push did this for every changed-file check,
 * so a push touching ~600+ files silently skipped the CLAUDE.md guards and
 * the workflow lints, and the negated "section reverted" check could block a
 * push that had removed nothing (found 2026-09-29 while landing BRO-4328:
 * land.yml's pre-push.test.mjs failed only on the large branch).
 *
 * Safe form: `grep -q PATTERN <<<"$VAR"` (no pipe, no SIGPIPE).
 * Pure so tests/unit/pipefail-grep-q-check.test.mjs can require() it.
 */

// Any `set` line that turns pipefail on (-o pipefail, -euo pipefail,
// -o errexit -o pipefail, ...).
const PIPEFAIL_RE = /^\s*set\s+[^\n#]*\bpipefail\b/m;
// echo/printf of a variable whose pipeline ends in an early-exiting grep
// (-q/--quiet in any flag position), possibly through intermediate stages
// such as `| tr ' ' '\n' |`.
const RISKY_RE = /\b(?:echo|printf)\b[^|\n]*\$\{?[A-Za-z_][A-Za-z0-9_]*[^|\n]*(?:\|[^|\n]*)*\|\s*grep\b[^|\n]*?(?:\s-[a-zA-Z]*q[a-zA-Z]*\b|\s--quiet\b)/;

/** @returns {{line:number, text:string}[]} risky lines ([] when the script has no pipefail) */
function findPipefailGrepQ(source) {
  const text = String(source || '');
  if (!PIPEFAIL_RE.test(text)) return [];
  const hits = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    if (RISKY_RE.test(l) && !/pipefail-grep-q-ok/.test(l)) hits.push({ line: i + 1, text: l.trim() });
  });
  return hits;
}

module.exports = { findPipefailGrepQ };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  // No args: scan the repo's shell scripts (scripts/**/*.sh, the git hooks,
  // .claude/hooks/*.sh, .github/**/*.sh).
  function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.git') && e.name !== '.github') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.sh')) out.push(p);
    }
    return out;
  }
  const root = path.resolve(__dirname, '../..');
  const files = process.argv.length > 2 ? process.argv.slice(2) : [
    ...walk(path.join(root, 'scripts'), []),
    ...walk(path.join(root, '.github'), []),
    ...walk(path.join(root, '.claude/hooks'), []),
    ...['pre-push', 'pre-commit', 'commit-msg'].map(h => path.join(root, 'scripts/hooks', h)),
  ].map(p => path.relative(root, p));
  process.chdir(root);
  let total = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const h of findPipefailGrepQ(src)) {
      total++;
      console.log(`${f}:${h.line}: ${h.text}`);
    }
  }
  if (total) {
    console.error(`\n${total} pipefail + "echo | grep -q" line(s). Use: grep -q PATTERN <<<"$VAR" (or add # pipefail-grep-q-ok with a reason).`);
    process.exit(1);
  }
}
