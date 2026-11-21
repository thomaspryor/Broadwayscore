#!/usr/bin/env node
/**
 * audit-duplicate-of-floor.js — mechanical guard on the duplicateOf gate floor.
 *
 * WHY THIS EXISTS (task #1002, six-reviewer plan-review finding):
 * `audit-duplicate-of-url-mismatch.js --gate` blocks the trunk only on a mass
 * SPIKE of stale duplicateOf pointers, because a spike means a producer
 * regression and auto-healing it would flood scoring with double-counted
 * reviews (rationale: scripts/lib/duplicate-of-gate.js). Raising
 * FIX_SURGE_THRESHOLD is therefore the single most dangerous "fix" available:
 * it is the ONLY way to turn this failure green without fixing anything, so a
 * session under time pressure reaches for it, and a live data-corrupting
 * regression goes silent. The pre-mortem named this the most likely
 * catastrophic outcome of the card that produced this guard.
 *
 * A prose rule in a Notion card is not enforcement. This is:
 * the floor may only move if scripts/.duplicate-of-floor.json is updated in the
 * SAME change AND names an evidence file that actually exists. Fixing the
 * false-positive source (which is what #1002 did — excluding archive/tombstone
 * dirs from the scan) does not move the floor and trips nothing.
 *
 * Usage:
 *   node scripts/audit-duplicate-of-floor.js          # exit 1 on drift
 *   node scripts/audit-duplicate-of-floor.js --help   # usage only, no side effects
 *
 * Exit codes: 0 = floor matches its pin, 1 = unauthorised or malformed change.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `audit-duplicate-of-floor.js — fails if the duplicateOf gate floor changed without linked evidence.

Usage:
  node scripts/audit-duplicate-of-floor.js
  node scripts/audit-duplicate-of-floor.js --help, -h    print this usage and exit

Reads FIX_SURGE_THRESHOLD from scripts/audit-duplicate-of-url-mismatch.js and
compares it to the pinned value in scripts/.duplicate-of-floor.json. To change
the floor: edit the constant, update the pin to match, and set evidenceFile to
an existing repo-relative path justifying the new value.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const REPO_ROOT = path.join(__dirname, '..');
const AUDIT_PATH = path.join(__dirname, 'audit-duplicate-of-url-mismatch.js');
const PIN_PATH = path.join(__dirname, '.duplicate-of-floor.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
}

function main() {
  let source;
  try {
    source = fs.readFileSync(AUDIT_PATH, 'utf-8');
  } catch (e) {
    fail(`cannot read ${path.relative(REPO_ROOT, AUDIT_PATH)}: ${e.message}`);
    return;
  }

  // Match the declaration, not any mention, so a comment referencing the number
  // cannot satisfy or break the guard.
  const match = source.match(/^const\s+FIX_SURGE_THRESHOLD\s*=\s*(\d+)\s*;/m);
  if (!match) {
    fail(
      'FIX_SURGE_THRESHOLD declaration not found in scripts/audit-duplicate-of-url-mismatch.js. ' +
      'It was renamed, moved, or made dynamic — any of which removes the floor from this guard\'s reach. ' +
      'Restore a top-level `const FIX_SURGE_THRESHOLD = <n>;` or update this guard deliberately.'
    );
    return;
  }
  const actual = Number(match[1]);

  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf-8'));
  } catch (e) {
    fail(`cannot read/parse scripts/.duplicate-of-floor.json: ${e.message}`);
    return;
  }

  if (typeof pin.floor !== 'number') {
    fail('scripts/.duplicate-of-floor.json: "floor" must be a number.');
    return;
  }

  if (actual !== pin.floor) {
    fail(
      `duplicateOf gate floor changed: FIX_SURGE_THRESHOLD is ${actual} but scripts/.duplicate-of-floor.json pins ${pin.floor}. ` +
      'This gate blocks only on a producer-regression SPIKE, so raising the floor silences real data corruption rather than fixing it. ' +
      'If the count is high, fix the SOURCE of the mismatches (task #1002 removed 27 by excluding archive/tombstone dirs from the scan). ' +
      'If the floor genuinely must move, update the pin in the same change and set "evidenceFile" to a path that documents the measurement.'
    );
    return;
  }

  // A pinned evidenceFile must exist. A dangling path would let a future change
  // launder itself through a filename that was deleted or never written.
  if (pin.evidenceFile != null) {
    if (typeof pin.evidenceFile !== 'string' || !pin.evidenceFile.trim()) {
      fail('scripts/.duplicate-of-floor.json: "evidenceFile" must be null or a non-empty repo-relative path.');
      return;
    }
    const evidencePath = path.join(REPO_ROOT, pin.evidenceFile);
    if (!fs.existsSync(evidencePath)) {
      fail(
        `scripts/.duplicate-of-floor.json names evidenceFile "${pin.evidenceFile}" but that file does not exist. ` +
        'A floor change must point at real, committed evidence.'
      );
      return;
    }
  }

  console.log(
    `✅ duplicateOf gate floor pinned at ${actual}` +
    (pin.evidenceFile ? ` (evidence: ${pin.evidenceFile})` : ' (never moved)')
  );
}

main();
