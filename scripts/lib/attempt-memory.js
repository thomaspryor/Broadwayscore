/**
 * attempt-memory.js — durable per-card failure memory for the autonomous
 * nightly loop (owner mandate 2026-07-30, task #635: "fix the system so
 * that [it doesn't allow] things to be re-attempted and fail and burn
 * money"). The loop was paused 2026-07-27 (task #599, "groundhog day")
 * because a card that failed overnight had no memory the next night — it
 * looked brand-new and got re-attempted, burning spend on a provably broken
 * card indefinitely.
 *
 * This is a PURE decision layer over the loop's existing append-only ledger
 * (scripts/lib/autonomous-ledger.js) — no new store, no new machinery. It
 * reads `card-fail`/`card-pass`/`auto-approve` entries that carry a
 * `contentHash` (stamped by the executor at write time, see
 * autonomous-run.js's fail()/pass paths) and decides whether a card has
 * failed the same content too many times to keep retrying blind.
 *
 * Policy: a card that failed `maxFailures` times (default 2) IN A ROW with
 * an UNCHANGED content hash is parked. It re-enters the pool the moment
 * either signal says "something changed":
 *   - the card's own content hash changes (the owner edited notes/title —
 *     a different card text deserves a fresh attempt)
 *   - an explicit owner override newer than the last recorded failure (a
 *     manual "clear the park, try again" without editing the text)
 * A `pass`/`auto-approve` in between always resets the streak to zero.
 *
 * Entries written before this feature shipped carry no `contentHash` and are
 * silently excluded from every count — old history can never seed a false
 * park.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..', '..');
const OVERRIDES_PATH = path.join(REPO, 'data', 'audit', 'attempt-memory-overrides.json');

const DEFAULT_MAX_FAILURES = 2;

// Stable hash of the content that actually determines what the loop would
// attempt — title + notes. Anything else on the card (priority, tags,
// status) can churn without changing the work itself. 16 hex chars is
// plenty of collision resistance for a few thousand backlog cards and keeps
// ledger lines short.
function computeContentHash(card) {
  const basis = `${(card && card.name) || ''}\n${(card && card.notes) || ''}`;
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 16);
}

// This card's chronological attempt outcomes, derived from the shared
// ledger. Only ledger lines carrying a `contentHash` count.
function attemptOutcomesForCard(ledgerEntries, cardId) {
  const outcomes = [];
  for (const e of ledgerEntries || []) {
    if (!e || e.cardId !== cardId || !e.contentHash) continue;
    if (e.event === 'card-fail') {
      outcomes.push({ ts: e.ts, contentHash: e.contentHash, outcome: 'fail', reason: e.note || null });
    } else if (e.event === 'card-pass' || e.event === 'auto-approve') {
      outcomes.push({ ts: e.ts, contentHash: e.contentHash, outcome: 'pass', reason: null });
    }
  }
  outcomes.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return outcomes;
}

// ── Manual park overrides (owner "clear the park, try again" without an edit) ──

function loadParkOverrides(overridesPath = OVERRIDES_PATH) {
  try { return JSON.parse(fs.readFileSync(overridesPath, 'utf8')); }
  catch { return {}; }
}

function saveParkOverride(cardId, overridesPath = OVERRIDES_PATH) {
  const overrides = loadParkOverrides(overridesPath);
  overrides[cardId] = new Date().toISOString();
  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  const tmp = `${overridesPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2) + '\n');
  fs.renameSync(tmp, overridesPath);
  return overrides[cardId];
}

/**
 * Should this card be skipped as "parked: failed twice unchanged"?
 * @param {Array} ledgerEntries - full ledger (readEntries().entries), any order.
 * @param {string} cardId
 * @param {string} currentContentHash - computeContentHash() of the FRESH card.
 * @param {object} [opts]
 * @param {number} [opts.maxFailures] - default 2.
 * @param {object} [opts.overrides] - { [cardId]: isoTimestamp } — cardId → when the
 *   owner cleared the park. Failures at or before that timestamp never count.
 * @returns {{parked: boolean, failureStreak: number, reason: string|null}}
 */
function checkPark(ledgerEntries, cardId, currentContentHash, opts = {}) {
  const maxFailures = Number.isInteger(opts.maxFailures) ? opts.maxFailures : DEFAULT_MAX_FAILURES;
  const overrides = opts.overrides || {};
  const outcomes = attemptOutcomesForCard(ledgerEntries, cardId);
  if (!outcomes.length) return { parked: false, failureStreak: 0, reason: null };

  const overrideAt = overrides[cardId] ? new Date(overrides[cardId]).getTime() : null;

  // Walk newest → oldest, counting a consecutive run of failures on the
  // CURRENT hash. Stop at the first pass, the first hash mismatch (the card
  // was edited), or the first entry that predates an owner override.
  const streak = [];
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const o = outcomes[i];
    if (overrideAt !== null && new Date(o.ts).getTime() < overrideAt) break;
    if (o.contentHash !== currentContentHash) break;
    if (o.outcome !== 'fail') break;
    streak.push(o);
  }

  if (streak.length < maxFailures) return { parked: false, failureStreak: streak.length, reason: null };

  const reasons = streak.slice(0, 2).reverse().map(o => o.reason).filter(Boolean);
  const reason = `parked: failed ${streak.length}x unchanged${reasons.length ? ` (${reasons.join(' | ')})` : ''} — edit the card or clear the park to retry`;
  return { parked: true, failureStreak: streak.length, reason };
}

module.exports = {
  DEFAULT_MAX_FAILURES,
  OVERRIDES_PATH,
  computeContentHash,
  attemptOutcomesForCard,
  loadParkOverrides,
  saveParkOverride,
  checkPark,
};
