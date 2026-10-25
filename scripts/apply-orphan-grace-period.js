#!/usr/bin/env node
/**
 * apply-orphan-grace-period.js
 *
 * Used by .github/workflows/self-heal-orphan-show-files.yml (BRO-3507).
 * Deletes orphan slim show files (public/data/shows/{id}.json) directly,
 * but only once an id has looked orphaned for 24h straight — see
 * scripts/lib/orphan-grace-period.js for why. Does NOT shell out to
 * `audit-orphan-show-ids.js --fix`: that script computes its exit code from
 * the orphan count captured BEFORE deletion, so it exits 1 even after a
 * fully successful fix — a workflow step naively trusting that exit code
 * would report failure (and skip the commit) on every single successful run.
 *
 * Usage:
 *   node scripts/apply-orphan-grace-period.js <audit-json-path>
 *
 * <audit-json-path> is the raw output of `node scripts/audit-orphan-show-ids.js --json`
 * (this script does not re-run the audit itself, to avoid a second corpus
 * scan and a second chance to hit MIN_PLAUSIBLE_SHOWS races).
 *
 * Always exits 0 on a normal run (deletion succeeded or nothing was due) —
 * genuine errors (bad input JSON, fs failures) throw and exit non-zero so
 * notify-failure fires instead of silently no-oping.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { updateGraceState, GRACE_HOURS_DEFAULT } = require('./lib/orphan-grace-period.js');

const USAGE = `apply-orphan-grace-period.js — delete orphan slim show files past a 24h grace period.

Usage:
  node scripts/apply-orphan-grace-period.js <audit-json-path>
  node scripts/apply-orphan-grace-period.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const SLIM_SHOWS_DIR = path.join(ROOT, 'public', 'data', 'shows');
const STATE_PATH = path.join(ROOT, 'data', 'audit', 'orphan-show-ids-grace.json');

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }
  const auditJsonPath = args[0];
  if (!auditJsonPath) {
    console.error('Usage: node scripts/apply-orphan-grace-period.js <audit-json-path>');
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(auditJsonPath, 'utf-8'));
  const currentIds = (audit.orphans && audit.orphans.slimShowFiles) || [];

  let previousState = null;
  try {
    previousState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    // Missing/corrupt state — every current id starts its grace clock fresh.
  }

  const { readyToDelete, newState } = updateGraceState(currentIds, previousState, Date.now());

  for (const id of readyToDelete) {
    const p = path.join(SLIM_SHOWS_DIR, `${id}.json`);
    fs.unlinkSync(p);
    console.log(`Deleted ${p} (orphaned ${GRACE_HOURS_DEFAULT}h+)`);
  }

  const stillInGrace = currentIds.filter((id) => !readyToDelete.includes(id));
  if (stillInGrace.length) {
    console.log(`Still in grace period (< ${GRACE_HOURS_DEFAULT}h orphaned, not deleted yet): ${stillInGrace.join(', ')}`);
  }
  if (!readyToDelete.length && !stillInGrace.length) {
    console.log('No orphan slim show files to process.');
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2) + '\n');
  console.log(`Deleted ${readyToDelete.length}, ${stillInGrace.length} still in grace period.`);
}

main();
