#!/usr/bin/env node
/**
 * BRO-2945: ADVISORY audit. Lists workflow lines doing a flat multi-path
 * `git add a b c` (atomic: one missing pathspec stages nothing). Exit 0 always;
 * do NOT wire as a blocking gate (CLAUDE.md rule 19). Fix with
 * scripts/lib/git-add-safe.sh, but only where a writer really can drop a file.
 *
 * Usage: node scripts/audit-flat-git-add.js [workflowsDir]
 */
const fs = require('fs');
const path = require('path');

// Returns [{line, text, paths, masked}] for flat multi-path git add lines.
function findFlatGitAdds(content) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    const start = i + 1;
    while (/\\\s*$/.test(text) && i + 1 < lines.length) text = text.replace(/\\\s*$/, ' ') + lines[++i].trim();
    const m = text.match(/(?:^|[;&|]\s*|\s)git add\s+([^;&|#]*)/);
    if (!m || /^\s*#/.test(text)) continue;
    const args = m[1].replace(/\s+\d*>&?\s*\S+/g, '').trim().split(/\s+/).filter(Boolean);
    const paths = args.filter(a => !a.startsWith('-') && a !== '--' && a !== '2>&1');
    if (paths.length < 2) continue;
    out.push({ line: start, text: text.trim(), paths, masked: /\|\|\s*true/.test(text) });
  }
  return out;
}

function main() {
  const dir = process.argv[2] || path.join(__dirname, '..', '.github', 'workflows');
  let total = 0;
  for (const f of fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort()) {
    const hits = findFlatGitAdds(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const h of hits) {
      total++;
      console.log(`${f}:${h.line}${h.masked ? ' [masked by || true]' : ''}: ${h.paths.length} paths: ${h.text}`);
    }
  }
  console.log(`\n[advisory] ${total} flat multi-path git add line(s). Convert only where a writer can delete/skip a listed file.`);
}

if (require.main === module) main();
module.exports = { findFlatGitAdds };
