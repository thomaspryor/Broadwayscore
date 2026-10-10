#!/usr/bin/env node
/**
 * sweep-resolved-alert-cards.js — cancel auto-filed alert cards whose
 * condition has cleared (BRO-4487). Selection rules and why they are narrow:
 * scripts/lib/resolved-alert-card-sweep.js.
 *
 *   node scripts/sweep-resolved-alert-cards.js            report only
 *   node scripts/sweep-resolved-alert-cards.js --apply    cancel eligible cards (max 25 per run)
 *
 * Reads the CI-tracked ledger (data/audit/alert-ledger.json). Cancels through
 * linear-brain.js, so the cancel-reason gate applies. Exit 0 on success
 * (including "nothing to do"), 3 when Linear could not be read.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { ledgerCandidates, skipReason, cancelReason, routineLogCancelReason } = require('./lib/resolved-alert-card-sweep.js');

const REPO = path.join(__dirname, '..');
const LEDGER = path.join(REPO, 'data', 'audit', 'alert-ledger.json');
const MAX_PER_RUN = 50;
const USAGE = 'Usage: node scripts/sweep-resolved-alert-cards.js [--apply]';

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const apply = argv.includes('--apply');
  const linear = require('./lib/linear-client.js');
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const now = Date.now();
  const candidates = ledgerCandidates(ledger);
  const counts = {};
  let cancelled = 0;
  for (const { identifier, conditionKey } of candidates) {
    let issue;
    try {
      issue = await linear.getIssue(identifier);
    } catch (err) {
      console.error(`[sweep-resolved-alert-cards] could not read ${identifier}: ${err.message}`);
      return 3;
    }
    const reason = skipReason(issue, conditionKey);
    if (reason) { counts[reason] = (counts[reason] || 0) + 1; continue; }
    if (!apply) { console.log(`would cancel ${identifier} (${conditionKey})`); counts.eligible = (counts.eligible || 0) + 1; continue; }
    if (cancelled >= MAX_PER_RUN) { counts['over-run-cap'] = (counts['over-run-cap'] || 0) + 1; continue; }
    const r = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', identifier, '--state', 'Canceled', '--cancel-reason', cancelReason(conditionKey)],
      { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) { cancelled++; console.log(`cancelled ${identifier} (${conditionKey})`); }
    else { counts['cancel-failed'] = (counts['cancel-failed'] || 0) + 1; console.error(`cancel failed for ${identifier}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`); }
  }
  // Finished opening-night routine logs (no ledger entry; matched by title).
  let open = [];
  try { open = await linear.listOpenIssuesWithDescriptions(); } catch (err) {
    console.error(`[sweep-resolved-alert-cards] could not list open issues: ${err.message}`);
    return 3;
  }
  for (const issue of open) {
    const why = routineLogCancelReason(issue, now);
    if (!why) continue;
    if (!apply) { console.log(`would cancel ${issue.identifier} (${issue.title})`); counts['log-eligible'] = (counts['log-eligible'] || 0) + 1; continue; }
    if (cancelled >= MAX_PER_RUN) { counts['over-run-cap'] = (counts['over-run-cap'] || 0) + 1; continue; }
    const r = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', issue.identifier, '--state', 'Canceled', '--cancel-reason', why],
      { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) { cancelled++; console.log(`cancelled ${issue.identifier} (${issue.title})`); }
    else { counts['cancel-failed'] = (counts['cancel-failed'] || 0) + 1; console.error(`cancel failed for ${issue.identifier}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`); }
  }
  console.log(`[sweep-resolved-alert-cards] ledger candidates ${candidates.length}; ${apply ? `cancelled ${cancelled}; ` : ''}${JSON.stringify(counts)}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[sweep-resolved-alert-cards] ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { main };
