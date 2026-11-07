#!/usr/bin/env node
/**
 * audit-raw-mean-scores.js — flags code that averages reviews' assignedScore
 * instead of using the canonical Critic Score (BRO-4313, CLAUDE.md §3).
 *
 * Usage:
 *   node scripts/audit-raw-mean-scores.js            # report; exit 0
 *   node scripts/audit-raw-mean-scores.js --strict   # exit 1 on any non-allowlisted hit
 *   node scripts/audit-raw-mean-scores.js --json
 *
 * Fix a hit by using the canonical score: computeSlimCriticScore() from
 * scripts/lib/slim-critic-score.js (in-pipeline), getCriticScore() from
 * scripts/lib/canonical-critic-scores.ts (analysis/external copy), or the
 * slim file's `cs`. If averaging raw per-review scores is the point (an
 * internal diagnostic), add the path to ALLOWLIST in
 * scripts/lib/raw-mean-scores.js with the reason.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { auditRawMeanScores, isScannable } = require('./lib/raw-mean-scores');

const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log(`Usage: node scripts/audit-raw-mean-scores.js [--strict] [--json]

Flags code that raw-means reviews' assignedScore instead of the canonical
Critic Score (scripts/lib/slim-critic-score.js / canonical-critic-scores.ts).
Read-only. Exit 0 (report) unless --strict and a non-allowlisted hit exists.`);
  process.exit(0);
}
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['scripts', 'src'];

function walk(rel, out) {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(childRel, out);
    } else if (isScannable(childRel)) {
      out.push({ path: childRel, source: fs.readFileSync(path.join(ROOT, childRel), 'utf8') });
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((r) => walk(r, []));
const result = auditRawMeanScores(files);

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: files.length, ...result }, null, 2));
} else {
  console.log(`Raw-mean-of-assignedScore audit: ${files.length} files scanned, ${result.allowed.length} allowlisted, ${result.violations.length} flagged.`);
  for (const v of result.violations) {
    console.log(`::warning file=${v.path},line=${v.lines[0]}::raw mean of assignedScore (lines ${v.lines.join(', ')}). Use the canonical Critic Score (scripts/lib/slim-critic-score.js or canonical-critic-scores.ts), or allowlist with a reason in scripts/lib/raw-mean-scores.js.`);
  }
  for (const p of result.staleAllowlist) {
    console.log(`ℹ️  allowlist entry no longer matches anything, remove it: ${p}`);
  }
  if (result.violations.length === 0) console.log('✅ No unallowlisted raw means.');
}
process.exit(STRICT && result.violations.length > 0 ? 1 : 0);
