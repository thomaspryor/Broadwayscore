#!/usr/bin/env node
/**
 * audit-stale-baseline-exceptions.js (BRO-2257)
 *
 * A passing --update-baseline gate can be misread as a settled design decision
 * when the baseline entry is really unmigrated debt (BRO-1699: two alert
 * senders sat in .alert-sender-baseline.json labelled "permanent
 * real-time-critical" until a later card migrated them). This scans every
 * tracked baseline JSON for permanence language in its STRING values (entry
 * reasons, notes, descriptions). Debt must not be labelled permanent: migrate
 * it and shrink the baseline, or, for a genuine architectural constraint,
 * add the file to ALLOWED below with the reason re-litigating is unnecessary.
 *
 * Read-only. Exit 0 clean, 1 findings.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PERMANENCE = /\b(permanent(ly)?|indefinite(ly)?|stays? (in (the )?)?baselined?|deliberate(ly)? (exception|stays?|exempt|kept|retained)|forever|never (migrate|fix)|won'?t fix)\b|permanent_/i;
// Show ids / slugs / URLs ("on-a-clear-day-you-can-see-forever-2011") are data, not prose.
const SLUG_OR_URL = /^(https?:\/\/\S+|[a-z0-9./:-]+)$/;

// file -> why a permanence label is genuinely justified (none today).
const ALLOWED = {};

const BASELINE_FILE = /(^|\/)[^/]*baseline[^/]*\.json$/;

function listBaselines(root) {
  const out = execFileSync('git', ['ls-files', '*baseline*.json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((f) => BASELINE_FILE.test(f));
}

function collectStrings(v, p, acc) {
  if (typeof v === 'string') acc.push([p, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => collectStrings(x, `${p}[${i}]`, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectStrings(x, `${p}.${k}`, acc);
  return acc;
}

function findPermanentLabels(json) {
  return collectStrings(json, '$', []).filter(([, s]) => !SLUG_OR_URL.test(s) && PERMANENCE.test(s)).map(([p, s]) => ({ path: p, text: s.slice(0, 160) }));
}

function audit(root) {
  const findings = [];
  const skipped = [];
  const files = listBaselines(root);
  for (const f of files) {
    if (ALLOWED[f]) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) {
      // Some *baseline*.json files are text snapshots, not JSON: warn, don't fail.
      skipped.push(f);
      continue;
    }
    for (const h of findPermanentLabels(json)) findings.push({ file: f, ...h });
  }
  return { files, findings, skipped };
}

module.exports = { audit, findPermanentLabels, PERMANENCE };

if (require.main === module) {
  const { files, findings, skipped } = audit(path.join(__dirname, '..'));
  console.log(`Scanned ${files.length - skipped.length} of ${files.length} baseline files.`);
  for (const f of skipped) console.log(`  warning: ${f} is not parseable JSON, skipped`);
  for (const f of findings) console.log(`  ${f.file} ${f.path}: ${f.text}`);
  if (findings.length) {
    console.log('Permanence language in a baseline: migrate the entry, or document why it is architectural (ALLOWED).');
    process.exit(1);
  }
  console.log('No stale "permanent exception" labels.');
}
