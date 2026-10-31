#!/usr/bin/env node
/**
 * autonomous-calibrate.js — measure triage quality against the golden corpus.
 *
 * Runs the full triage path (deterministic pre-filter + live Sonnet call)
 * over tests/fixtures/triage-calibration.json, writes each card's `recorded`
 * verdict back into the fixture, and prints the agreement report.
 *
 * Bars (from the sprint plan / calibration test):
 *   - size agreement ≥80% over cards where both golden.size and a recorded
 *     size exist (pre-filter-refused cards never get a size — excluded)
 *   - absolute exclusions 100%: no deny-tag / excluded-category card may ever
 *     be recorded eligible
 *   - eligibility agreement reported (informational)
 *
 * Re-run after ANY triage-prompt change (scripts/lib/autonomous-triage-core.js
 * buildTriagePrompt), commit the updated fixture, and keep the colocated test
 * (scripts/lib/triage-calibration.test.mjs) green. Costs ~20 Sonnet calls.
 */

const fs = require('fs');
const path = require('path');
const { triageCard, decide } = require('./lib/autonomous-triage-core.js');
const { callSonnet } = require('./autonomous-triage.js');
const { DENY_TAGS, EXCLUDED_CATEGORIES } = require('./lib/autonomous-eligibility.js');

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'triage-calibration.json');

function isAbsoluteExclusion(card) {
  return (card.tags || []).some(t => DENY_TAGS.has(String(t).toLowerCase())) ||
    EXCLUDED_CATEGORIES.has(String(card.category || '').toLowerCase());
}

async function main() {
  // --help must never spend real Sonnet calls (cousin bug class #260).
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('autonomous-calibrate.js — re-runs triage over the calibration fixture (SPENDS Sonnet).\n  --help, -h   show this message, do nothing else');
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [i, card] of fixture.cards.entries()) {
    const r = await triageCard(card, callSonnet);
    card.recorded = {
      at: new Date().toISOString(),
      preFilterEligible: r.preFilter.eligible,
      preFilterReason: r.preFilter.reason || null,
      decision: decide({ ...r, card }),
      size: r.triage ? r.triage.size : null,
      eligible: r.preFilter.eligible ? (r.triage ? r.triage.eligible : null) : false,
      failed: r.failed || null,
      reason: r.triage ? r.triage.reason : (r.error || null),
    };
    console.error(`[calibrate] ${i + 1}/${fixture.cards.length} ${card.name} → ${card.recorded.decision}${card.recorded.size ? ` (${card.recorded.size})` : ''}`);
  }

  // ── agreement report ──
  const sized = fixture.cards.filter(c => c.golden.size && c.recorded.size);
  const sizeAgree = sized.filter(c => c.golden.size === c.recorded.size);
  const elig = fixture.cards.filter(c => c.recorded.eligible !== null || c.recorded.preFilterEligible === false);
  const eligAgree = elig.filter(c => c.golden.eligible === (c.recorded.eligible === true));
  const absolutes = fixture.cards.filter(isAbsoluteExclusion);
  const absoluteViolations = absolutes.filter(c => c.recorded.eligible === true);
  const failed = fixture.cards.filter(c => c.recorded.failed);

  const summary = {
    at: new Date().toISOString(),
    sizeAgreement: { agree: sizeAgree.length, of: sized.length, pct: sized.length ? Math.round(100 * sizeAgree.length / sized.length) : null },
    eligibilityAgreement: { agree: eligAgree.length, of: elig.length, pct: elig.length ? Math.round(100 * eligAgree.length / elig.length) : null },
    absoluteExclusions: { violations: absoluteViolations.map(c => c.name), of: absolutes.length },
    triageFailures: failed.map(c => c.name),
    disagreements: {
      size: sized.filter(c => c.golden.size !== c.recorded.size).map(c => `${c.name}: golden ${c.golden.size} vs recorded ${c.recorded.size}`),
      eligibility: elig.filter(c => c.golden.eligible !== (c.recorded.eligible === true)).map(c => `${c.name}: golden ${c.golden.eligible} vs recorded ${c.recorded.eligible}`),
    },
  };
  fixture.lastCalibration = summary;
  fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n');

  console.log(JSON.stringify(summary, null, 2));
  const pass = (summary.sizeAgreement.pct ?? 100) >= 80
    && (summary.eligibilityAgreement.pct ?? 100) >= 90
    && absoluteViolations.length === 0
    && failed.length === 0;
  console.error(pass ? '[calibrate] PASS' : '[calibrate] FAIL — iterate the prompt (buildTriagePrompt), not the golden labels');
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error(`[calibrate] fatal: ${err.message}`); process.exit(1); });
