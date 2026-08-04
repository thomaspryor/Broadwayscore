#!/usr/bin/env node
/**
 * Parity check for decideCriticListingPromotion() (task #995, Sprint 2).
 *
 * v1's parity test (superseded — see card 3b1637c5/#987) replayed candidates
 * against data/audit/ob-venue-candidates.json, the STAGING file. Promotion
 * EMPTIES a confirmed candidate out of staging, so that corpus always passed
 * trivially — it could never contain evidence the new gate over-confirmed.
 *
 * This check instead replays data/audit/ob-promotion-log.jsonl (kind:'promote'),
 * the append-only audit trail of every show ever actually promoted, via
 * isCandidateConfirmed (playbill/lortel) or decideRegionalPromotion (regional
 * aggregator roundup) or an admin override — never via the critic-listing path,
 * because that source class did not exist when any of these were promoted.
 *
 * The safety property this proves: decideCriticListingPromotion is a pure
 * ADDITION (git diff on ob-cross-validation.js shows isCandidateConfirmed
 * byte-identical) that does not retroactively confirm anything a different,
 * untouched gate already decided — 0 of the historical promotions should
 * confirm via the new function when replayed with only the fields the log
 * actually recorded (title, venue — no sourceUrl/dates ever persisted there,
 * so a false confirm here would mean the new gate is dangerously loose, not
 * that it "agrees" with history).
 *
 * Usage:
 *   node scripts/audit-critic-listing-parity.js
 *   node scripts/audit-critic-listing-parity.js --json
 *
 * Exit codes: 0 = 0 diffs (safe); 1 = the new gate confirmed a historical
 * entry it shouldn't have (would-be diff — investigate before shipping).
 */

const USAGE = `audit-critic-listing-parity.js — parity check for decideCriticListingPromotion()

Usage:
  node scripts/audit-critic-listing-parity.js [--json]
  node scripts/audit-critic-listing-parity.js --help, -h    print this usage and exit
`;

function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return 0; }

  const fs = require('fs');
  const path = require('path');
  const { decideCriticListingPromotion } = require('./lib/ob-cross-validation.js');

  const asJson = process.argv.includes('--json');
  const logPath = path.join(__dirname, '..', 'data', 'audit', 'ob-promotion-log.jsonl');

  let lines = [];
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    console.error(`Failed to read ${logPath}: ${e.message}`);
    return 1;
  }

  const promotions = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && entry.kind === 'promote') promotions.push(entry);
  }

  const diffs = [];
  for (const p of promotions) {
    // Only the fields the log actually persists — no sourceUrl/articlePublishedAt/
    // discoveredAt ever landed here, so an honest replay can't fabricate them.
    const candidate = { title: p.title, venue: p.venue };
    const r = decideCriticListingPromotion(candidate);
    if (r.confirmed) {
      diffs.push({ id: p.id, title: p.title, venue: p.venue, originalSource: p.confirmationSource, newReason: r.reason });
    }
  }

  const result = {
    historicalPromotions: promotions.length,
    diffs: diffs.length,
    ok: diffs.length === 0,
    diffDetail: diffs,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Replayed ${result.historicalPromotions} historical promotion(s) from ${path.relative(process.cwd(), logPath)}.`);
    if (result.ok) {
      console.log(`0 diffs — decideCriticListingPromotion() confirms none of them (expected: none were critic-listing-sourced).`);
    } else {
      console.error(`::error::${result.diffs} historical promotion(s) unexpectedly confirm via decideCriticListingPromotion() — gate is too loose:`);
      for (const d of diffs) console.error(`  ${d.id} — "${d.title}" (${d.venue}), originally via ${d.originalSource}: ${d.newReason}`);
    }
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
