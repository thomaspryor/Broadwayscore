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
// Stamp parsing lives in a zero-dependency leaf so stuck-work.js (daily
// health digest) can share the exact predicate without dragging in this
// module's verify-gate dependency chain. Re-exported below unchanged.
const { RECHECK_AFTER_RE, parseRecheckAfter, parseRecheckAfterFromCard } = require('./recheck-stamp.js');
// Also a zero-dependency leaf. Lets this module say "the notes you handed me
// are a TRUNCATED PREVIEW" instead of silently judging a card on 1800 chars
// of it — see needsOverflowHydration below.
const { cardHasOverflow } = require('./overflow-marker.js');

// A card only recently marked Done is worth re-checking; anything older was
// either already re-checked or has been true for long enough that a nightly
// re-run adds nothing. Superseded per-card by an explicit RECHECK-AFTER stamp
// (see parseRecheckAfter/doneWithinWindow below).
const DEFAULT_WINDOW_HOURS = 24;

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
  // a card is never un-selected just because a run was missed). Scans
  // notes AND outcome (task 3b06: sessions naturally write the stamp into
  // Outcome at wrap-up, and those stamps were invisible here — 3 of 5 live
  // stamped cards could never trigger their own recheck).
  const recheckAfter = parseRecheckAfterFromCard(card);
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
 * Does this card have to be re-read through notion-brain's `get` (loadCard)
 * before its acceptance criteria can be trusted?
 *
 * THE bug this whole path had (2026-08-14). `notion-brain.js list
 * --include-notes` returns the raw Notion property, and notion-brain caps a
 * property at 1800 chars: longer notes are stored as a preview plus an
 * overflow marker, with the tail in the page body. `## Acceptance criteria`
 * is written LAST on this repo's cards, so on a long card it is exactly what
 * falls past the cut. The recheck then read a preview, found no runnable
 * command, and dropped the card silently — 14 of 18 RECHECK-AFTER-stamped
 * cards on the live board were truncated this way.
 *
 * The stamp itself survives (notion-brain hoists it to the front on write —
 * see hoistRecheckAfterStamp), which is precisely why this predicate works:
 * the caller can still tell a stamped card from an unstamped one off the
 * preview, and only has to pay for a `get` on the stamped, truncated few
 * rather than on every long card in the listing.
 * @param {{notes?:string,outcome?:string,keyFiles?:string}|null} card
 */
function needsOverflowHydration(card) {
  if (!card) return false;
  if (parseRecheckAfterFromCard(card) == null) return false;
  return cardHasOverflow(card);
}

/**
 * The card's own runnable acceptance command, from notes OR outcome.
 *
 * Notes first (the author-controlled acceptance-criteria field), then
 * outcome. Outcome is scanned because sessions naturally write their wrap-up
 * — stamp AND acceptance command — into Outcome, which is already why
 * parseRecheckAfterFromCard scans it for the DATE. Scanning it for the date
 * but never for the COMMAND made that whole class inert by construction: the
 * card was correctly selected as due and then immediately dropped for having
 * no command, with the command sitting in the very field the date came from.
 *
 * Safe to widen because extractVerifyCmd is not a backtick scraper: it only
 * looks inside an `## Acceptance criteria` section or a `VERIFY:` line, and
 * every candidate still has to pass isSafeCheckCommand. Prose in an Outcome
 * cannot become an executed command by being long.
 */
function verifiabilityForCard(card) {
  const fromNotes = evaluateVerifiability((card && card.notes) || '');
  if (fromNotes.cmd) return { ...fromNotes, source: 'notes' };
  const fromOutcome = evaluateVerifiability((card && card.outcome) || '');
  if (fromOutcome.cmd) return { ...fromOutcome, source: 'outcome' };
  return { ...fromNotes, source: null };
}

/**
 * Which Done (or Paused-with-RECHECK-AFTER) cards should be re-checked
 * tonight, and with what.
 *
 * @param {object} o
 * @param {{id:string,name:string,status?:string,notes?:string,outcome?:string,ageDays:number,completedDate?:string|null,lastEditedAt?:string|null}[]} o.doneCards - notion-brain list --status Done,Paused --sort edited --include-notes
 * @param {{event:string,taskId:string,notionId?:string,verifyCmd?:string|null,verifyReason?:string|null,subject?:string,ts?:string}[]} o.launchEntries - dispatch-ledger
 * @param {number} [o.windowHours]
 * @param {(cardId:string)=>boolean} [o.isClaimed] - a card someone is actively working RIGHT NOW is skipped
 * @param {number} [o.now] - injectable clock for tests
 * @param {(drop:{cardId:string,name:string,reason:string})=>void} [o.onDrop] - see the drop branch below
 * @returns {{cardId:string,name:string,verifyCmd:string|null,reason:string|null,skip:string|null}[]}
 */
function selectRecheckTargets({ doneCards, launchEntries, windowHours = DEFAULT_WINDOW_HOURS, isClaimed = () => false, now = Date.now(), lastRecheckedAt = () => null, onDrop = () => {} }) {
  // Latest launch per card wins: a card dispatched twice should be re-checked
  // with the command from its most recent dispatch, not a stale earlier one.
  //
  // Keyed on notionId OR linearId: bsc-next writes `notionId: null, linearId:
  // <id>` for a Linear-sourced dispatch (48 such launches in the live ledger),
  // so a notionId-only key can never match one however the cards are sourced.
  // Inert until a caller feeds this Linear-sourced cards — every card in the
  // nightly path comes from notion-brain and carries a Notion UUID — but the
  // map is now correct by construction rather than correct by accident of who
  // happens to call it. (The 58 launches with no id field at all are
  // unmatchable in principle: there is nothing to key them on. They predate
  // the notionId stamp.)
  const byCard = new Map();
  for (const e of launchEntries || []) {
    if (e.event !== 'launch') continue;
    const key = e.notionId || e.linearId;
    if (!key) continue;
    const prev = byCard.get(key);
    if (!prev || String(e.ts || '') >= String(prev.ts || '')) byCard.set(key, e);
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
      const gate = verifiabilityForCard(card);
      if (!gate.cmd) {
        // THE SILENT DROP, ended (2026-08-14). This used to be a bare
        // `continue`: no result row, no ledger entry, no line in the morning
        // email, not even counted as "unverifiable". A card carrying a
        // RECHECK-AFTER stamp is a written promise that someone would check
        // back later that the fix held — dropping it without a word is the
        // one outcome the stamp exists to make impossible, and it is what
        // made 10+ stamped cards (two of them P0s about main being red)
        // completely invisible for weeks.
        //
        // Stamped cards therefore become a REPORTED row (status
        // 'unverifiable' downstream, rendered by the morning digest as "no
        // way to check this automatically") rather than a disappearance.
        // They cost no checkout and no run time — the runner never executes
        // an unverifiable target — so this is a reporting change, not a
        // workload one.
        //
        // Cards WITHOUT a stamp stay quiet on purpose: they got here through
        // the blanket 24h Done-window, this brain closes 80-90 cards a day,
        // and most of them never had machine-runnable criteria to begin with.
        // Emitting a row each would flood the digest and — because rows
        // consume the nightly 10-card budget — starve the real rechecks. They
        // are handed to onDrop instead, so the caller can COUNT the class in
        // the summary even though it does not name each card. Invisible was
        // the bug; uncounted is not acceptable either.
        const reason = gate.reason || 'card has no runnable acceptance criteria';
        if (parseRecheckAfterFromCard(card) == null) {
          onDrop({ cardId: card.id, name: card.name || '(untitled)', reason });
          continue;
        }
        if (isClaimed(card.id)) {
          out.push({ cardId: card.id, name: card.name || '(untitled)', verifyCmd: null, reason: null, skip: 'someone is working this card right now' });
          continue;
        }
        out.push({
          cardId: card.id,
          name: card.name || '(untitled)',
          verifyCmd: null,
          reason: `RECHECK-AFTER stamp is due but ${reason}`,
          skip: null,
        });
        continue;
      }
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
  // Starvation guard (Codex ship-check finding, task #695): a RECHECK-AFTER
  // stamp stays due forever once its date passes, and with a fixed run limit
  // the same permanently-due cards would win the slot every single night —
  // any card newly due AFTER the limit fills up would never get a turn.
  // Never-yet-rechecked cards (including brand-new ones) sort first; among
  // already-rechecked cards, the longest-stale one goes next. A stable sort
  // preserves doneCards order as the tiebreak, so single-card callers (every
  // existing test) are unaffected.
  out.sort((a, b) => (lastRecheckedAt(a.cardId) ?? -Infinity) - (lastRecheckedAt(b.cardId) ?? -Infinity));
  return out;
}

// pass  — the card's own check still passes against fresh main
// fail  — it does not (SHADOW: reported only, the card is not reopened)
// unverifiable — no runnable command was ever captured
// noCriteria — in the window, but never became a target at all: no stamp AND
//   no runnable criteria (selectRecheckTargets' onDrop). Counted rather than
//   listed — see the drop branch there for why these stay unnamed — but
//   counted is the point: a whole class of card silently vanishing between
//   "selected" and "reported" is exactly the failure that hid the truncation
//   bug for weeks. `0` when the caller passes nothing, so every existing
//   caller's counts object is unchanged in shape and value.
function summarize(results, { noCriteria = 0 } = {}) {
  const c = { pass: 0, fail: 0, unverifiable: 0, skipped: 0, noCriteria: Number(noCriteria) || 0 };
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
  parseRecheckAfterFromCard,
  needsOverflowHydration,
  verifiabilityForCard,
  doneWithinWindow,
  selectRecheckTargets,
  summarize,
  shouldExitShadow,
  describeResult,
};
