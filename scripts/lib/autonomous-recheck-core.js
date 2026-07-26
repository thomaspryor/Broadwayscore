/**
 * autonomous-recheck-core.js — pure decisions for the nightly acceptance
 * recheck (Sprint 3, S3-T2/T5). I/O lives in
 * scripts/autonomous-acceptance-recheck.js; everything judgeable lives here so
 * it can be unit-tested without Notion, git, or a subprocess.
 *
 * The problem it exists for: "Done" is currently a claim. A session (human or
 * autonomous) marks a card Done and nothing ever re-checks it. The recheck
 * re-runs the card's OWN acceptance-criteria command against a fresh checkout
 * of main, days after the branch that produced it is gone, and reports what it
 * finds. In SHADOW mode it only reports — it never reopens a card — because a
 * recheck that reopens work on a false positive burns owner trust faster than
 * an unverified Done ever did.
 */

'use strict';

// A card only recently marked Done is worth re-checking; anything older was
// either already re-checked or has been true for long enough that a nightly
// re-run adds nothing.
const DEFAULT_WINDOW_HOURS = 24;

// Was the card marked Done inside the window? "Done recently" is a property
// of when the card was COMPLETED, not when it was created — the original
// ageDays (created_time) filter silently excluded almost every dispatched
// card, because cards are usually older than the window by the time their
// work finishes (2026-07-26 incident: 3 dispatched cards completed overnight,
// recheck matched 0, every night since the recheck shipped). completedDate is
// date-only (midnight UTC); lastEditedAt carries the real timestamp of the
// Done flip, so the freshest of the two decides.
function doneWithinWindow(card, windowHours, now) {
  const cutoff = now - windowHours * 3600 * 1000;
  const stamps = [card.completedDate, card.lastEditedAt]
    .map(v => Date.parse(v))
    .filter(Number.isFinite);
  if (stamps.length) return Math.max(...stamps) >= cutoff;
  // No completion signal at all: fall back to creation age, still requiring an
  // actual number (Number(null) coerces to 0, which is finite and would put an
  // unknown-age card inside EVERY window — the very hole the old guard's
  // comment described but didn't close).
  return typeof card.ageDays === 'number' && Number.isFinite(card.ageDays) && card.ageDays <= windowHours / 24;
}

/**
 * Which Done cards should be re-checked tonight, and with what.
 *
 * @param {object} o
 * @param {{id:string,name:string,ageDays:number,completedDate?:string|null,lastEditedAt?:string|null}[]} o.doneCards - notion-brain list --status Done --sort edited
 * @param {{event:string,taskId:string,notionId?:string,verifyCmd?:string|null,verifyReason?:string|null,subject?:string,ts?:string}[]} o.launchEntries - dispatch-ledger
 * @param {number} [o.windowHours]
 * @param {(cardId:string)=>boolean} [o.isClaimed] - a card someone is actively working RIGHT NOW is skipped
 * @param {number} [o.now] - injectable clock for tests
 * @returns {{cardId:string,name:string,verifyCmd:string|null,reason:string|null,skip:string|null}[]}
 */
function selectRecheckTargets({ doneCards, launchEntries, windowHours = DEFAULT_WINDOW_HOURS, isClaimed = () => false, now = Date.now() }) {
  // Latest launch per card wins: a card dispatched twice should be re-checked
  // with the command from its most recent dispatch, not a stale earlier one.
  const byCard = new Map();
  for (const e of launchEntries || []) {
    if (e.event !== 'launch' || !e.notionId) continue;
    const prev = byCard.get(e.notionId);
    if (!prev || String(e.ts || '') >= String(prev.ts || '')) byCard.set(e.notionId, e);
  }

  const out = [];
  for (const card of doneCards || []) {
    if (!card || !card.id) continue;
    if (!doneWithinWindow(card, windowHours, now)) continue;
    const launch = byCard.get(card.id);
    if (!launch) continue; // never dispatched through bsc-next — nothing was captured to re-run
    if (isClaimed(card.id)) {
      out.push({ cardId: card.id, name: card.name || launch.subject || '(untitled)', verifyCmd: null, reason: null, skip: 'someone is working this card right now' });
      continue;
    }
    out.push({
      cardId: card.id,
      name: card.name || launch.subject || '(untitled)',
      verifyCmd: launch.verifyCmd || null,
      // "not machine-verifiable" is an honest, reportable outcome — the recheck
      // never invents a command for a card whose criteria was prose.
      reason: launch.verifyCmd ? null : (launch.verifyReason || 'no verify command was captured at dispatch'),
      skip: null,
    });
  }
  return out;
}

// pass  — the card's own check still passes against fresh main
// fail  — it does not (SHADOW: reported only, the card is not reopened)
// unverifiable — no runnable command was ever captured
function summarize(results) {
  const c = { pass: 0, fail: 0, unverifiable: 0, skipped: 0 };
  for (const r of results || []) {
    if (r.skip) c.skipped++;
    else if (r.status === 'pass') c.pass++;
    else if (r.status === 'fail') c.fail++;
    else c.unverifiable++;
  }
  return c;
}

// ── Shadow-mode exit (S3-T5) ────────────────────────────────────────────────
//
// Enforcement (reopening a card automatically) turns on only when the shadow
// record justifies it — an OBJECTIVE bar, not "it felt right". All three must
// hold, and a single false reopen resets the case entirely: the failure mode
// that matters is the loop reopening finished work on a bad signal, which
// costs the owner more trust than a stale Done ever costs them time.
const SHADOW_EXIT = Object.freeze({ minDays: 7, minRechecks: 10, maxFalsePositives: 0 });

function shouldExitShadow({ days, rechecks, falsePositives } = {}, bar = SHADOW_EXIT) {
  const d = Number(days), r = Number(rechecks), f = Number(falsePositives);
  if (!Number.isFinite(d) || !Number.isFinite(r) || !Number.isFinite(f)) return false;
  return d >= bar.minDays && r >= bar.minRechecks && f <= bar.maxFalsePositives;
}

// One line per card for the morning email's recheck section, in the owner's
// language (no command strings, no card ids — those live in the ledger).
function describeResult(r) {
  if (r.skip) return `${r.name}: skipped, ${r.skip}`;
  if (r.status === 'pass') return `${r.name}: still works`;
  if (r.status === 'fail') return `${r.name}: its own check does not pass any more`;
  return `${r.name}: no way to check this automatically`;
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  SHADOW_EXIT,
  doneWithinWindow,
  selectRecheckTargets,
  summarize,
  shouldExitShadow,
  describeResult,
};
