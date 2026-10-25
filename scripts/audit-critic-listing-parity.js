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
 * Two checks, reported separately (ship-check adversarial review finding,
 * task #995 — a single "0 diffs" number here would repeat v1's mistake of
 * a check that passes unconditionally rather than one that tests something):
 *
 * 1. REAL-FIELD REPLAY (the pass/fail gate). Only the fields the log
 *    actually persists (title, venue — no source/sourceUrl/dates ever landed
 *    there). Proves decideCriticListingPromotion is a pure ADDITION that
 *    doesn't retroactively confirm anything a different, untouched gate
 *    already decided: every historical entry lacks a 'nyt-theater' source
 *    and a persisted URL, so 0 should confirm. A false confirm here would
 *    mean the new gate is reachable without its required fields — a real bug.
 *
 * 2. SYNTHETIC-COMPLETE REPLAY (informational only, NOT pass/fail). Same
 *    title/venue, but with source:'nyt-theater' + a synthetic sourceUrl +
 *    aligned dates filled in — isolating what the venue-canonical-list check
 *    alone would decide if this candidate HAD arrived via the critic-listing
 *    path. Expect this to run HIGH: data/off-broadway-venues.json is built
 *    FROM shows.json's own catalogued Off-Broadway venues (build-ob-venues.js),
 *    so a historically-promoted show's venue is near-tautologically already
 *    "canonical." A high pass rate here is not a red flag; report it so a
 *    reviewer isn't misled into reading check #1's 0-diffs as proof the gate
 *    is well-calibrated on venue alone — it is not, by construction.
 *
 * Usage:
 *   node scripts/audit-critic-listing-parity.js
 *   node scripts/audit-critic-listing-parity.js --json
 *
 * Exit codes: 0 = check #1 passes (0 diffs); 1 = check #1 fails — the new
 * gate confirmed a historical entry using only log-persisted fields, meaning
 * it's reachable without a real source/URL (investigate before shipping).
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

  // Check 1: real-field replay — the pass/fail gate.
  const diffs = [];
  for (const p of promotions) {
    const candidate = { title: p.title, venue: p.venue };
    const r = decideCriticListingPromotion(candidate);
    if (r.confirmed) {
      diffs.push({ id: p.id, title: p.title, venue: p.venue, originalSource: p.confirmationSource, newReason: r.reason });
    }
  }

  // Check 2: synthetic-complete replay — informational venue-check discriminating
  // power, NOT a pass/fail signal (see header comment for why a high rate is expected).
  const NOW = new Date().toISOString();
  const wouldConfirmSynthetic = [];
  for (const p of promotions) {
    const candidate = {
      title: p.title,
      venue: p.venue,
      source: 'nyt-theater',
      sourceUrl: 'synthetic://parity-check',
      articlePublishedAt: NOW,
      discoveredAt: NOW,
    };
    const r = decideCriticListingPromotion(candidate);
    if (r.confirmed) wouldConfirmSynthetic.push({ id: p.id, title: p.title, venue: p.venue });
  }

  const result = {
    historicalPromotions: promotions.length,
    realFieldDiffs: diffs.length,
    ok: diffs.length === 0,
    diffDetail: diffs,
    syntheticCompleteConfirmCount: wouldConfirmSynthetic.length,
    syntheticCompleteConfirmRate: promotions.length ? wouldConfirmSynthetic.length / promotions.length : null,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Replayed ${result.historicalPromotions} historical promotion(s) from ${path.relative(process.cwd(), logPath)}.`);
    console.log('');
    console.log(`Check 1 (real-field replay, PASS/FAIL): ${result.realFieldDiffs} diffs.`);
    if (result.ok) {
      console.log(`  0 diffs — decideCriticListingPromotion() confirms none of them using only log-persisted fields.`);
    } else {
      console.error(`  ::error::${result.realFieldDiffs} historical promotion(s) confirm using ONLY log-persisted fields — the gate is reachable without a real source/URL:`);
      for (const d of diffs) console.error(`    ${d.id} — "${d.title}" (${d.venue}), originally via ${d.originalSource}: ${d.newReason}`);
    }
    console.log('');
    console.log(`Check 2 (synthetic-complete replay, INFORMATIONAL — not pass/fail): ${result.syntheticCompleteConfirmCount}/${result.historicalPromotions} would confirm if fed a synthetic nyt-theater source + aligned dates.`);
    console.log(`  Expected HIGH: data/off-broadway-venues.json is built from these very shows' venues, so this mostly tests "is the venue catalogued" — not gate precision.`);
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
