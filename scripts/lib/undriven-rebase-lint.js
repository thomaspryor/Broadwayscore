// BRO-5552: find inline `git pull --rebase` / `git rebase` / `git merge` /
// `git cherry-pick` calls in .github/ that carry no merge=ours driver, so
// `-X theirs` can line-blend two whole-file regenerations of a snapshot
// (BRO-5551). A call is fine when its line names scripts/lib/merge-keep-run.sh
// or push-with-retry, or the line / the one above has `keep-run-ok: <reason>`
// (calls in a repo with no autostash=regenerated paths, or whose own
// per-file merge logic owns the policy).
const fs = require('fs');
const path = require('path');

// Verbs that can replay or merge file content. --abort/--skip/--quit and
// merge-base/merge-file/merge-tree never write a blend.
const CALL = /\bgit\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*(pull\b(?=[^\n]*(?:--(?:no-)?rebase|\s-r\b|-X\s))|rebase\b(?!\s+--(?:abort|skip|quit))|merge\b(?![-\w])(?!\s+--abort)|cherry-pick\b(?!\s+--(?:abort|quit|skip)))/;
const OK = /merge-keep-run\.sh|^[^#]*push-with-retry\.sh|keep-run-ok:/;

function findUndriven(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (!CALL.test(line)) return;
    if (OK.test(line) || (i > 0 && /^\s*#.*keep-run-ok:/.test(lines[i - 1]))) return;
    out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.ya?ml$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function scanRepo(root) {
  const res = [];
  for (const f of walk(path.join(root, '.github'))) {
    for (const v of findUndriven(fs.readFileSync(f, 'utf8'))) res.push({ file: path.relative(root, f), ...v });
  }
  return res;
}

module.exports = { findUndriven, scanRepo };
