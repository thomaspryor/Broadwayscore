'use strict';
/**
 * Visible failure record for the opening-night lane (BRO-4784). The lane's whole point is no silent gates: a fetch or
 * score that fails is written here with its reason, attempt number and next retry time, and a review that exhausts its
 * retries gets a terminal record. The ledger's stages stay as they are (a review that never scored has no `scored`
 * event); this file says WHY. Append-only JSONL next to the ledger: <show>-<night>.failures.jsonl.
 */
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');

const STAGES = ['fetch', 'score'];

function failuresPath(dir, show, night) {
  return ledger.ledgerPath(dir, show, night).replace(/\.jsonl$/, '.failures.jsonl'); // validates show and night
}

function appendFailure(dir, { show, night, reviewKey, stage, reason, attempt, terminal = false, nextRetryAt = null, at } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`lane-failures: unknown stage "${stage}"`);
  if (!reviewKey || typeof reviewKey !== 'string') throw new Error('lane-failures: reviewKey is required');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('lane-failures: attempt must be a positive integer');
  const ts = new Date(at === undefined ? Date.now() : at);
  if (Number.isNaN(ts.getTime())) throw new Error(`lane-failures: bad timestamp "${at}"`);
  const rec = { show, night, reviewKey, stage, reason: String(reason || 'unknown').slice(0, 300), attempt, terminal: terminal === true, nextRetryAt: nextRetryAt === null ? null : new Date(nextRetryAt).toISOString(), at: ts.toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(failuresPath(dir, show, night), `${JSON.stringify(rec)}\n`);
  return rec;
}

function readFailures(dir, show, night) {
  let text = '';
  try { text = fs.readFileSync(failuresPath(dir, show, night), 'utf8'); } catch { return { failures: [], corrupt: 0 }; }
  const failures = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { failures.push(JSON.parse(line)); } catch { corrupt++; } // a half-written last line must not hide the rest
  }
  return { failures, corrupt };
}

/**
 * What still needs a human or a later retry: terminal failures, and keys whose last failure has no later success.
 * `scoredKeys` is the set of review keys that reached `scored` in the ledger.
 */
function unresolved(failures, scoredKeys = new Set()) {
  const last = new Map();
  for (const f of failures) last.set(f.reviewKey, f);
  return [...last.values()].filter((f) => !scoredKeys.has(f.reviewKey));
}

module.exports = { STAGES, failuresPath, appendFailure, readFailures, unresolved };
