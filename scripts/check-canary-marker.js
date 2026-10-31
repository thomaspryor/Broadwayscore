#!/usr/bin/env node
/**
 * check-canary-marker.js — machine-checkable acceptance criteria for the
 * daily digest-autofix canary card (task #1225, Digest-autofix S6).
 *
 * Exit 0 iff data/audit/canary-<date>.marker exists. This is the entire
 * "fix" the canary card asks a headless bsc-next session to perform (`touch
 * <marker path>`), and the exact command scripts/lib/autofix-canary.js's
 * buildCanaryCardNotes() embeds as the card's armed verify command — see
 * autonomous-triage-core.js's SAFE_CHECK_FORMS entry for the shape this
 * regex-locks (--date must be a strict YYYY-MM-DD token).
 *
 * Exit codes: 0 marker present (fixed) · 1 marker absent · 2 usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');

function markerPath(dateStr) {
  return path.join(__dirname, '..', 'data', 'audit', `canary-${dateStr}.marker`);
}

function main(argv) {
  const arg = (argv || []).find((a) => a.startsWith('--date='));
  const dateStr = arg ? arg.slice('--date='.length) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error('Usage: node scripts/check-canary-marker.js --date=YYYY-MM-DD');
    process.exit(2);
  }

  const exists = fs.existsSync(markerPath(dateStr));
  console.log(exists
    ? `PRESENT — ${markerPath(dateStr)} exists (canary fix landed)`
    : `ABSENT — ${markerPath(dateStr)} does not exist yet`);
  process.exit(exists ? 0 : 1);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { markerPath };
