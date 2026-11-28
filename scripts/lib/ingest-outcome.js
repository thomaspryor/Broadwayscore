'use strict';
// BRO-6872: ingest-review-from-url.js --stub-on-failure exits 0 after writing only a retry stub, so hourly callers stay
// quiet. execute-approved-fix.js read that exit as "review recovered" and marked the plan applied while the review never
// reached the site. The ingest now reports a stub outcome to a file the caller names, and the fix runner fails the action.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = 'INGEST_OUTCOME_FILE';

function newOutcomeFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-outcome-')), 'outcome.json');
}

/** Called by the ingest; a no-op unless the caller asked for the outcome. */
// One ingest per action: the last write wins and a success writes nothing (BRO-7999: except
// { outcome: 'held-out' }, a success whose record an exclusion rule keeps off the site), so a script that ran the
// ingest several times under one env would let one stub fail the whole action.
function writeIngestOutcome(outcome, env = process.env) {
  const file = env[ENV];
  if (!file) return;
  // BRO-7999 (Codex ship-check): 'held-out' is a note, never allowed to replace a failure
  // (retry-stub / skipped) another write in the same action already reported.
  if (outcome && outcome.outcome === 'held-out' && stubProblem(readIngestOutcome(file))) return;
  try { fs.writeFileSync(file, JSON.stringify(outcome)); } catch (e) { console.error(`⚠️  could not write ingest outcome: ${e.message}`); }
}

function readIngestOutcome(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function removeOutcomeFile(file) {
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* temp dir */ }
}

/** @returns {string|null} why the action did not recover a review, or null when it did (or reported nothing). */
function stubProblem(outcome, script = 'ingest-review-from-url.js') {
  if (!outcome) return null;
  if (outcome.outcome === 'retry-stub') return `${script} filed only a retry stub (${outcome.reason || 'fetch failed'}); no review text reached the site`;
  if (outcome.outcome === 'skipped') return `${script} skipped the page (${outcome.reason || 'skipped'}); no review text reached the site`;
  return null;
}

/** BRO-7999: { outcome: 'held-out', rule } = the review is on file but an exclusion rule keeps it off the site. */
function heldOutNote(outcome) {
  if (!outcome || outcome.outcome !== 'held-out') return null;
  return `review is on file but held out of the site by ${outcome.rule || 'an exclusion rule'}`;
}

/**
 * BRO-7999: after a plan's LAST action, the reasons each held-out ingest still is (a later
 * action may have cleared its flag). classify(showId, filepath) -> rule | null | undefined.
 */
// Opening-night holds that lift on their own when reviews drop: expected, not a failed fix.
const SELF_CLEARING_RULES = new Set(['previewPlaceholder', 'prematureForUnopenedShow']);
function stillHeldOut(results, classify) {
  const reasons = [];
  for (const r of results || []) {
    if (!r || !r.heldOut) continue;
    const rule = classify(r.heldOut.showId, r.heldOut.filepath);
    if (rule && !SELF_CLEARING_RULES.has(rule)) reasons.push(`${path.basename(r.heldOut.filepath)} is on file but still held out of the site by ${rule} after every action ran`);
  }
  return reasons;
}

module.exports = { ENV, newOutcomeFile, writeIngestOutcome, readIngestOutcome, removeOutcomeFile, stubProblem, heldOutNote, stillHeldOut, SELF_CLEARING_RULES };
