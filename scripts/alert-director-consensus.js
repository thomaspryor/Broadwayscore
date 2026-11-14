#!/usr/bin/env node
'use strict';
/**
 * alert-director-consensus.js (BRO-7210)
 *
 * Files/refreshes ONE worker card from the weekly director-consensus audit's JSON
 * (STRICT + ZERO findings) and clears it when clean. Kept out of
 * audit-show-director-consensus.js so that audit stays a pure read (it is on the
 * safe-form allowlist). Never changes the audit's exit code: this is its own step.
 *
 * Usage: node scripts/alert-director-consensus.js <audit-output.json>
 */
const fs = require('fs');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.log('alert-director-consensus: no audit output; nothing to do'); return; }
  let out;
  try { out = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`alert-director-consensus: unreadable audit output (${e.message}); nothing to do`); return; }
  const decision = require('./lib/director-consensus-alert').decideDirectorConsensusAlert(out.findings, out.scannedShows);
  await require('./lib/audit-alert').routeAuditDecisions(decision, 'alert-director-consensus');
}
main().catch((e) => { console.error(e); });
