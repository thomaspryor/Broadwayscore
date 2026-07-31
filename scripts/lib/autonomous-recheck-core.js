/**
 * autonomous-recheck-core.js — pure decisions for the nightly acceptance
 * recheck (Sprint 3, S3-T2/T5; widened by task #695). I/O lives in
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
 *
 * Task #695 widened this for deferred-effect fixes (a fix whose result is
 * only observable days out — next cron, next day's billing data, next
 * opening night): a card can carry an explicit `RECHECK-AFTER: YYYY-MM-DD`
 * stamp in its notes instead of relying on the 24h Done-window. Per the
 * process rule in /wrap-up, such a card is left in Paused (not Done) until
 * its stamp is reached, at which point this recheck is what has anything to
 * say about it at all.
 */

'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');

// A card only recently marked Done is worth re-checking; anything older was
// either already re-checked or has been true for long enough that a nightly
// re-run adds nothing. Superseded per-card by an explicit RECHECK-AFTER stamp
// (see parseRecheckAfter/doneWithinWindow below).
const DEFAULT_WINDOW_HOURS = 24;

// `RECHECK-AFTER: 2026-08-08` — case-insensitive, date-only (parsed as
// midnight UTC, i.e. the START of that day: the recheck becomes due the
// instant that UTC day begins, not at its end — a deferred-effect claim like
// "7-day spend streak" names the day its OWN window already closes on).
const RECHECK_AFTER_RE = /RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/i;

function parseRecheckAfter(notes) {
  const m = RECHECK_AFTER_RE.exec(String(notes || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// Was the card marked Done inside the window? Keyed on explicit completion
// signals: completedDate (date-only, parses as midnight UTC) and lastEditedAt
// (real timestamp of the Done flip) — freshest of the two decides. The old
// filter used ageDays, which notion-brain derives from last_edited_time, so
// it was a fuzzier proxy for the same thing; the 2026-07-26 incident's
// primary killer was the Priority-sorted Done LISTING never containing
// recently-completed cards at all (see notion-brain --sort edited). Explicit
// stamps also survive future changes to how ageDays is derived.
function doneWithinWindow(card, windowHours, now) {
  // An explicit per-card stamp always wins over the generic window — that's
  // the whole point of RECHECK-AFTER: the card's own author decided when its
  // deferred effect becomes checkable, which the blanket 24h Done-window
  // cannot know. Due the instant `now` reaches the stamped day; stays due
  // indefinitely after (same "still due" semantics the window itself has —
  // a card is never un-selected just because a run was missed).
  const recheckAfter = parseRecheckAfter(card.notes);
  if (recheckAfter != null) return now >= recheckAfter;

  // Without a stamp, only a Done card can be window-eligible — a Paused card
  // (the status /wrap-up uses for a deferred-effect fix awaiting its stamp)
  // has nothing "done" to verify yet and must never be picked up by the
  // generic ageDays/completedDate fallback below.
  if (card.status && card.status !== 'Done') return false;

  const cutoff = now - windowHours * 3600 * 1000;
  const stamps = [];
  // completedDate is date-only, so Date.parse gives midnight UTC — the START
  // of the completion day. Treat it as end-of-day (+24h) so a card completed
  // late in the day is not aged out early, especially under sub-24h windows
  // (Codex finding, 2026-07-26).
  const cd = Date.parse(card.completedDate);
  if (Number.isFinite(cd)) stamps.push(cd + 24 * 3600 * 1000);
  const le = Date.parse(card.lastEditedAt);
  if (Number.isFinite(le)) stamps.push(le);
  if (stamps.length) return Math.max(...stamps) >= cutoff;
  // No completion signal at all: fall back to creation age, still requiring an
  // actual number (Number(null) coerces to 0, which is finite and would put an
  // unknown-age card inside EVERY window — the very hole the old guard's
  // comment described but didn't close).
  return typeof card.ageDays === 'number' && Number.isFinite(card.ageDays) && card.ageDays <= windowHours / 24;
}

/**
 * Which Done (or Paused-with-RECHECK-AFTER) cards should be re-checked
 * tonight, and with what.
 *
 * @param {object} o
 * @param {{id:string,name:string,status?:string,notes?:string,ageDays:number,completedDate?:string|null,lastEditedAt?:string|null}[]} o.doneCards - notion-brain list --status Done,Paused --sort edited
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

    // No dispatch-ledger entry — most often a HUMAN session's card, which
    // bsc-next never touched, so nothing was ever captured to re-run. Fall
    // back to the card's OWN acceptance-criteria command (the same canonical
    // predicate bsc-next's dispatch gate and notion-brain's arming warning
    // already use) instead of leaving every human-shipped fix invisible to
    // this recheck. Still never invents a command: a card with no runnable
    // criteria in its notes is left alone exactly as before.
    if (!launch) {
      const gate = evaluateVerifiability(card.notes || '');
      if (!gate.cmd) continue;
      if (isClaimed(card.id)) {
        out.push({ cardId: card.id, name: card.name || '(untitled)', verifyCmd: null, reason: null, skip: 'someone is working this card right now' });
        continue;
      }
      out.push({ cardId: card.id, name: card.name || '(untitled)', verifyCmd: gate.cmd, reason: null, skip: null });
      continue;
    }

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
  RECHECK_AFTER_RE,
  SHADOW_EXIT,
  parseRecheckAfter,
  doneWithinWindow,
  selectRecheckTargets,
  summarize,
  shouldExitShadow,
  describeResult,
};
