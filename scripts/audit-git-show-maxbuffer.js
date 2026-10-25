#!/usr/bin/env node
/**
 * Flags execFileSync('git', ['show'|'cat-file'|'ls-tree'|'diff'|'log', ...])
 * calls that set no maxBuffer (BRO-3156). Node's 1MB default throws ENOBUFS on
 * large tracked files (reviews.json is ~20k reviews; stage-latency.jsonl is
 * 28MB), and callers that catch-and-treat-as-absent then misreport a real file
 * as missing. Four instances shipped before this audit (review-write-guard,
 * merge-commercial-conflict, reconcile-merged-json, triage-review-gap).
 *
 * Usage:
 *   node scripts/audit-git-show-maxbuffer.js [--root=<dir>] [--json]
 * Exits 0 when clean, 1 when any call lacks maxBuffer.
 */
const path = require('path');
const { scanTree } = require('./lib/git-maxbuffer-scan');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log('Usage: node scripts/audit-git-show-maxbuffer.js [--root=<dir>] [--json]');
  process.exit(0);
}

const rootArg = process.argv.find(a => a.startsWith('--root='));
const ROOT = rootArg ? path.resolve(rootArg.slice(7)) : path.join(__dirname, '..');
const findings = scanTree(ROOT);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
} else if (findings.length) {
  console.error(`${findings.length} git ${'show/cat-file/ls-tree/diff/log'} call(s) without maxBuffer:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.sub}] ${f.snippet}`);
  console.error('Add { maxBuffer: 512 * 1024 * 1024 } (see scripts/audit-outlet-routing-diff.js).');
} else {
  console.log('OK: every execFileSync git show/cat-file/ls-tree/diff/log call sets maxBuffer');
}
process.exit(findings.length ? 1 : 0);
