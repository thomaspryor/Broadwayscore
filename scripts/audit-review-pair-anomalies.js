#!/usr/bin/env node
/**
 * audit-review-pair-anomalies.js — READ-ONLY, advisory (BRO-4888 prevention).
 *
 * Walks data/review-texts/<show>/ and reports two shapes the per-file guards
 * cannot see (detectors in scripts/lib/review-pair-anomalies.js):
 *   pairs     same outlet, same text start and length, DIFFERENT critic names
 *             and DIFFERENT urls: one carries the wrong byline.
 *   roundup   isRoundupArticle=true on a per-article url on the outlet's own
 *             domain (stale flag; clear by hand through a pending-fixes plan).
 *
 * Usage:
 *   node scripts/audit-review-pair-anomalies.js               # summary + first 20 of each
 *   node scripts/audit-review-pair-anomalies.js --show=<id>   # one show dir
 *   node scripts/audit-review-pair-anomalies.js --list=pairs|roundup   # every finding
 *   node scripts/audit-review-pair-anomalies.js --json=<path> # write all findings
 *   node scripts/audit-review-pair-anomalies.js --strict      # exit 1 when anything is found
 * Never writes review data. Default exit 0 (new audits land advisory, CLAUDE.md rule 19).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { findSameTextDifferentByline, findOwnDomainRoundupFlags } = require('./lib/review-pair-anomalies');

const USAGE = `audit-review-pair-anomalies.js — read-only review-pair audit (BRO-4888).

Usage:
  node scripts/audit-review-pair-anomalies.js [--show=<id>] [--list=pairs|roundup] [--json=<path>] [--strict]
  node scripts/audit-review-pair-anomalies.js --help, -h    print this usage and exit
`;

function arg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return 0; }
  const root = resolveReviewTextsDir();
  const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : null;
  const only = arg('show');
  const dirs = listShowDirs(root, { silent: true }).filter((d) => !d.startsWith('_') && (!only || d === only));
  if (only && !dirs.length) { console.error(`No show dir: ${only}`); return 2; }

  const pairs = [];
  const roundup = [];
  let files = 0;
  for (const dir of dirs) {
    const records = [];
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.json')) continue;
      try { records.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8')) }); } catch { /* unreadable file: other audits own that */ }
    }
    files += records.length;
    for (const p of findSameTextDifferentByline(records)) pairs.push({ show: dir, ...p });
    for (const r of findOwnDomainRoundupFlags(records, registry)) roundup.push({ show: dir, ...r });
  }

  console.log(`audit-review-pair-anomalies: ${dirs.length} show dirs, ${files} files`);
  console.log(`  pairs   (same text, different byline and url): ${pairs.length}`);
  console.log(`  roundup (isRoundupArticle on the outlet's own url): ${roundup.length}`);
  const list = arg('list');
  const cap = list ? Infinity : 20;
  if (!list || list === 'pairs') for (const p of pairs.slice(0, cap)) console.log(`  pair   ${p.show}: ${p.files.join(' ~ ')}  (${p.names.join(' / ')})`);
  if (!list || list === 'roundup') for (const r of roundup.slice(0, cap)) console.log(`  roundup ${r.show}/${r.file}  ${r.url}`);
  const jsonPath = arg('json');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), showDirs: dirs.length, files, pairs, roundup }, null, 2));
  return process.argv.includes('--strict') && (pairs.length || roundup.length) ? 1 : 0;
}

process.exitCode = main();
