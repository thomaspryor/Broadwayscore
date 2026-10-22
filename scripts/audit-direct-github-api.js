#!/usr/bin/env node
/**
 * BRO-134: flags NEW scripts that call api.github.com directly instead of
 * scripts/lib/gh-api-client.js (fetchGitHubJSON / dispatchWorkflow), which
 * logs every call to ~/.claude/gh-api-call-ledger.log. Files in
 * data/audit/direct-github-api-baseline.json are the known leftovers
 * (mixed-service helpers, CI-isolated gates, write-only fetches); migrate one
 * and remove it from the baseline (stale entries are reported too).
 *
 * ADVISORY (CLAUDE.md §19): exit 0 always, unless --strict (new direct caller
 * or stale baseline entry => exit 1). Usage: node scripts/audit-direct-github-api.js [--strict] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { classify } = require('./lib/direct-github-api-scan.js');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'data/audit/direct-github-api-baseline.json');
const SKIP = /(\.test\.m?js$|[\\/]node_modules[\\/]|gh-api-(client|cache|wrapper)|direct-github-api-scan|audit-direct-github-api)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|mjs)$/.test(e.name) && !SKIP.test(p)) out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const files = walk(path.join(ROOT, 'scripts')).map((p) => ({
    file: path.relative(ROOT, p),
    text: fs.readFileSync(p, 'utf8'),
  }));
  let baseline = [];
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files; } catch { /* first run */ }
  const r = classify(files, baseline);
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`direct api.github.com callers: ${r.direct.length} (baseline ${baseline.length})`);
    for (const f of r.newDirect) console.log(`  NEW  ${f}  -> use scripts/lib/gh-api-client.js`);
    for (const f of r.staleBaseline) console.log(`  STALE baseline entry (migrated?): ${f}`);
  }
  process.exit(strict && (r.newDirect.length || r.staleBaseline.length) ? 1 : 0);
}

if (require.main === module) main();
