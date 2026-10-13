#!/usr/bin/env node
/**
 * BRO-2420: flag scripts that write data/audit/<file> inside a workflow whose
 * commit step never `git add`s it (the write is discarded at job end; BRO-182).
 *
 *   node scripts/audit-orphaned-audit-writes.js           report, exit 0 (advisory)
 *   node scripts/audit-orphaned-audit-writes.js --strict  exit 1 on any orphan
 *   node scripts/audit-orphaned-audit-writes.js --check   exit 1 only on orphans not in the baseline
 *   node scripts/audit-orphaned-audit-writes.js --update-baseline   rewrite the baseline (review the diff)
 *   node scripts/audit-orphaned-audit-writes.js --json
 *
 * Heuristic limits: paths held only in a lib constant/registry (e.g. the
 * ob-venue-candidates entry in core-data-merge-registry.js) are not followed;
 * composite-action staging is not read. a script is matched to a workflow by basename; writes made
 * by a child script or a lib constant are not followed. Documented false
 * positives go in EXEMPT with a reason.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { findOrphanedWrites } = require('./lib/orphaned-audit-writes');
const { hasHelpFlag } = require('./lib/cli-help.js');

// "script|data/audit/file": reason. Keep each entry justified.
const EXEMPT = {};

// Existing gaps found on first run (BRO-2420). Many are likely read-only or
// staged through a composite action; triage them down over time. --check fails
// only on NEW orphans so the gate lands advisory-safe.
const BASELINE_PATH = path.join(__dirname, '.orphaned-audit-writes-baseline.json');
const keyOf = (o) => `${o.script}|${o.file}`;

function loadBaseline() {
  try { return new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))); } catch { return new Set(); }
}

function readTree(dir, exts, rootRel) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      Object.assign(out, readTree(full, exts, `${rootRel}/${name}`));
    } else if (exts.some((e) => name.endsWith(e))) {
      out[`${rootRel}/${name}`] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

function run(root = path.join(__dirname, '..')) {
  const all = readTree(path.join(root, 'scripts'), ['.js', '.mjs', '.ts'], 'scripts');
  const scripts = {};
  for (const [k, v] of Object.entries(all)) if (!/\/(lib|codex)\//.test(k) && !/\.test\./.test(k)) scripts[k] = v;
  const workflows = readTree(path.join(root, '.github/workflows'), ['.yml', '.yaml'], '.github/workflows');
  return findOrphanedWrites(scripts, workflows, EXEMPT);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('usage: node scripts/audit-orphaned-audit-writes.js [--json] [--check] [--strict] [--update-baseline]');
    process.exit(0);
  }
  const orphans = run();
  if (process.argv.includes('--json')) console.log(JSON.stringify(orphans, null, 2));
  else {
    console.log(`[audit-orphaned-audit-writes] ${orphans.length} orphaned audit write(s)`);
    for (const o of orphans) console.log(`  ${o.script} writes ${o.file}; never staged by ${o.workflows.join(', ')}`);
  }
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(orphans.map(keyOf), null, 2) + '\n');
    console.log(`baseline written: ${orphans.length} entries`);
  }
  if (process.argv.includes('--check')) {
    const base = loadBaseline();
    const fresh = orphans.filter((o) => !base.has(keyOf(o)));
    for (const o of fresh) console.error(`NEW orphan: ${o.script} writes ${o.file} but ${o.workflows.join(', ')} never git-adds it`);
    if (fresh.length) process.exit(1);
  }
  if (process.argv.includes('--strict') && orphans.length) process.exit(1);
}

module.exports = { run, EXEMPT, keyOf, loadBaseline };
