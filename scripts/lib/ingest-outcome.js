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
// One ingest per action: the last write wins and a success writes nothing, so a script that ran the
// ingest several times under one env would let one stub fail the whole action.
function writeIngestOutcome(outcome, env = process.env) {
  const file = env[ENV];
  if (!file) return;
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

module.exports = { ENV, newOutcomeFile, writeIngestOutcome, readIngestOutcome, removeOutcomeFile, stubProblem };
