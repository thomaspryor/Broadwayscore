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
require('./cli-help').exitOnHelp(module);

const PERMANENCE = /\b(permanent(ly)?|indefinite(ly)?|(stays?|remains?) (in (the )?)?baselined?|(deliberate|intentional)(ly)? (exception|stays?|exempt(ed)?|excluded|kept|retained)|forever|never (migrate|fix)|won'?t fix)\b/i;
// URLs, paths and show ids ("on-a-clear-day-you-can-see-forever-2011") are data,
// not prose. Bare enum slugs ("permanent", "permanent-exception") are labels and
// ARE checked (BRO-5261 retro-review).
const URL_PATH_OR_SHOW_ID = /^(https?:\/\/\S+|[\w.-]*\/[\w./-]*|[\w.-]+\.[a-z]{1,5}|[a-z0-9-]+-\d{4}(-\d+)?)$/;

// camelCase / snake / kebab -> words, so "permanentException" and
// "permanent_exception" read as "permanent exception" and \b holds.
function toWords(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

// file -> why a permanence label is genuinely justified (none today).
const ALLOWED = {};

// Tracked *baseline*.json files that are text snapshots, not JSON. Any OTHER
// unparseable or unreadable file is reported as `unreadable` (the repo test
// fails on it), so a merge-broken baseline is not silently skipped.
const TEXT_SNAPSHOTS = new Set([
  'data/audit/scoring-delta-baseline-we-discovery-v2.json', // scoring-delta stdout capture
]);

// Allowlist / exception / exemption files carry the same "excused debt" entries.
const BASELINE_FILE = /(^|\/)[^/]*(baseline|allowlist|exception|exemption)[^/]*\.json$/;

function listBaselines(root) {
  const out = execFileSync('git', ['ls-files', '-z', '*baseline*.json', '*allowlist*.json', '*exception*.json', '*exemption*.json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0'))].filter((f) => BASELINE_FILE.test(f));
}

// Object keys are checked too: {"permanent": [...]} is a label.
function collectStrings(v, p, acc) {
  if (typeof v === 'string') acc.push([p, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => collectStrings(x, `${p}[${i}]`, acc));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc.push([`${p}.${k} (key)`, k]);
      collectStrings(x, `${p}.${k}`, acc);
    }
  }
  return acc;
}

function findPermanentLabels(json) {
  return collectStrings(json, '$', [])
    .filter(([, s]) => !URL_PATH_OR_SHOW_ID.test(s) && PERMANENCE.test(toWords(s)))
    .map(([p, s]) => ({ path: p, text: s.slice(0, 160) }));
}

function audit(root) {
  const findings = [];
  const skipped = [];
  const unreadable = [];
  const files = listBaselines(root);
  for (const f of files) {
    if (ALLOWED[f]) continue;
    if (TEXT_SNAPSHOTS.has(f)) { skipped.push(f); continue; }
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) {
      unreadable.push({ file: f, error: e.message.slice(0, 120) });
      continue;
    }
    for (const h of findPermanentLabels(json)) findings.push({ file: f, ...h });
  }
  return { files, findings, skipped, unreadable };
}

module.exports = { audit, findPermanentLabels, PERMANENCE, TEXT_SNAPSHOTS };

if (require.main === module) {
  const { files, findings, skipped, unreadable } = audit(path.join(__dirname, '..', '..'));
  console.log(`Scanned ${files.length - skipped.length - unreadable.length} of ${files.length} baseline files.`);
  for (const f of skipped) console.log(`  ${f}: text snapshot, skipped`);
  for (const u of unreadable) console.log(`  UNREADABLE ${u.file}: ${u.error}`);
  for (const f of findings) console.log(`  ${f.file} ${f.path}: ${f.text}`);
  if (unreadable.length) process.exitCode = 1;
  if (findings.length) {
    console.log('Permanence language in a baseline: migrate the entry, or document why it is architectural (ALLOWED).');
    process.exit(1);
  }
  console.log('No stale "permanent exception" labels.');
}
