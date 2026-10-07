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

const { evaluateVerifiability, isSafeCheckCommand } = require('./verify-gate.js');
// BRO-3551: the OPEN-backlog sweep (selectOpenBacklogSweepCandidates, near
// the bottom of this file) reuses the exact same dispatch-time gates
// bsc-next.js/linear-next.js already enforce, rather than inventing a
// second "is this card real work" predicate — CLAUDE.md §15.
const { autofixFiledIssueGuard } = require('./linear-dispatch.js');
const { classifyHeadlessDispatchability } = require('./headless-dispatchability.js');
// The single specificity ranking (node --test/npx tsx --test = 0, test -f =
// 1, everything else = 2) and the single candidate-extraction regex glue —
// exported from autonomous-verify-cmd.js so they're used here identically to
// how extractVerifyCmd ranks a card's own candidates against each other
// (BRO-3446; CLAUDE.md §15, never a second copy of either).
const { rank, rawCandidates } = require('./autonomous-verify-cmd.js');
// Stamp parsing lives in a zero-dependency leaf so stuck-work.js (daily
// health digest) can share the exact predicate without dragging in this
// module's verify-gate dependency chain. Re-exported below unchanged.
const { RECHECK_AFTER_RE, parseRecheckAfter, parseRecheckAfterFromCard } = require('./recheck-stamp.js');
// Also a zero-dependency leaf. Lets this module say "the notes you handed me
// are a TRUNCATED PREVIEW" instead of silently judging a card on 1800 chars
// of it — see needsOverflowHydration below.
const { cardHasOverflow } = require('./overflow-marker.js');

/**
 * The best correction for `snapshotCmd` found in `comments` — used to fix a
 * dispatch-ledger snapshot after the fact (BRO-3446).
 *
 * Two things evaluateVerifiability(notes, comments)'s own newest-wins rule
 * gets wrong for THIS use case, both found by testing against the real
 * BRO-3382 comment thread this ticket exists for, not fixtures:
 *
 * 1. That rule stops at the first document (scanning newest-first) that
 *    arms AT ALL. An unrelated LATER comment that happens to also arm (a
 *    wrap-up note with its own `VERIFY: npx next lint` boilerplate, say)
 *    would shadow an earlier, genuinely specific correction, and the
 *    phantom-path snapshot would never get corrected (ship-check finding,
 *    Codex). Fixed by scanning comments newest-first and skipping any that
 *    arm but don't meet the specificity bar, rather than stopping at the
 *    first one that arms at all.
 * 2. Within ONE comment, extractVerifyCmd's own first-at-best-rank tie-break
 *    picks the WRONG candidate for a correction comment specifically: the
 *    real BRO-3382 correction reads "The acceptance comment says: VERIFY:
 *    <phantom> ... So the correct command is: VERIFY: <real>" — both rank 0,
 *    phantom first. A correction restates the wrong path for context before
 *    the right one, so this needs the LAST safe candidate at the best rank
 *    within a comment, not the first — hence rawCandidates() + its own
 *    scan here instead of delegating to extractVerifyCmd's policy.
 * @param {string[]|undefined} comments - oldest-first, same contract as evaluateVerifiability
 * @param {string} snapshotCmd
 * @returns {string|null}
 */
function findCommentCorrection(comments, snapshotCmd) {
  const list = Array.isArray(comments) ? comments : [];
  const snapshotRank = rank(snapshotCmd);
  for (let i = list.length - 1; i >= 0; i--) {
    let best = null;
    for (const c of rawCandidates(String(list[i] || ''))) {
      if (!isSafeCheckCommand(c)) continue;
      const r = rank(c);
      if (r > snapshotRank) continue;
      if (!best || r <= rank(best)) best = c; // <=: among ties, the LAST one in the comment wins
    }
    if (best) return best;
  }
  return null;
}

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
 *
 * card.comments (oldest-first, BRO-3373) is threaded into both calls so a
 * Linear card's acceptance command — usually posted in a comment, since the
 * description is rarely edited after filing — is considered alongside
 * notes/outcome, newest-first, per evaluateVerifiability's own contract.
 * undefined for every pre-BRO-3373 (Notion) caller, so this is a no-op there.
 */
function verifiabilityForCard(card) {
  const comments = card && Array.isArray(card.comments) ? card.comments : undefined;
  const fromNotes = evaluateVerifiability((card && card.notes) || '', comments);
  if (fromNotes.cmd) return { ...fromNotes, source: 'notes' };
  const fromOutcome = evaluateVerifiability((card && card.outcome) || '', comments);
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
    // A dispatch-ledger verifyCmd is a SNAPSHOT taken when the card was
    // dispatched, and this branch used to treat it as the final word: a null
    // snapshot became `reason: launch.verifyReason` and the card's own
    // criteria were never consulted again. That makes every post-dispatch
    // correction inert here — the exact defect verify-gate.js:30-42 already
    // records and fixed for the DISPATCH gate under BRO-2796 ("a Linear
    // card's description cannot be edited by linear-brain.js's update
    // command, so the ONLY way to correct a broken or wrong VERIFY command
    // after dispatch is a comment"). The dispatch gate learned to read
    // comments; this path stayed pinned to the snapshot, so a session that
    // discovers its real acceptance command mid-flight and posts it — which
    // is what /wrap-up tells sessions to do — could never arm the nightly
    // recheck. Measured on the live board 2026-09-15 for the 2026-09-16
    // 06:45Z run: 3 of the 31 due cards (BRO-3030, BRO-2983, BRO-2795) were
    // armed on the card and dead here.
    //
    // Null-snapshot fallback: consulted whenever the snapshot is empty, so a
    // card that is unverifiable both ways reports exactly as it did before
    // and no working card can be downgraded.
    //
    // Non-null snapshot: BRO-3446. `--allow-phantom-path` lets a snapshot
    // freeze a path the dispatching session only guessed (BRO-3382: the
    // ledger named a test file its session never wrote; the real test landed
    // elsewhere and the real fix is correct and live on main), so the
    // nightly run would execute the phantom and report `fail` for working
    // code. Notes can't be edited after dispatch on a Linear card (BRO-2796
    // again), so a same-or-BETTER-specificity command posted in a COMMENT is
    // the one signal worth trusting over the snapshot — ranked via rank()
    // above (findCommentCorrection), not raw precedence, so a comment naming
    // a GENERIC command (`npx next lint`, rank 2) can never displace a
    // SPECIFIC snapshot (`node --test ...`, rank 0). That is exactly the
    // degradation "a dispatch-ledger launch entry still takes priority over
    // the notes fallback" pins by name below, and why plain notes (not a
    // comment) are deliberately NOT compared this way here — see "the
    // fallback is additive only" below, still pinned.
    //
    // KNOWN RESIDUAL (not fixed here, tracked in BRO-3461): rank() only
    // measures command SHAPE, not what a specific command actually re-verifies
    // — a single-file `node --test a.test.mjs` correction ties in rank with
    // and can therefore displace a multi-file snapshot covering `a.test.mjs
    // b.test.mjs`, and a bespoke `node scripts/audit-*.js` snapshot (rank 2,
    // same bucket as everything not node --test/test -f) can be displaced by
    // a bare `test -f` comment even though the audit script is the stronger
    // check. Also no timestamp guard against a stale pre-redispatch comment
    // tying with a freshly-corrected snapshot. Fixing either needs either a
    // richer rank() (repo-wide, CLAUDE.md §15 — one canonical copy, so that
    // change is not local to this file) or comment createdAt threaded through
    // linear-recheck-source.js's card.comments (currently plain strings) —
    // both bigger than this ticket's stated fix.
    let verifyCmd = launch.verifyCmd || null;
    if (verifyCmd) {
      const correction = findCommentCorrection(card.comments, verifyCmd);
      if (correction) verifyCmd = correction;
    }
    const fallback = verifyCmd ? null : verifiabilityForCard(card);
    verifyCmd = verifyCmd || (fallback && fallback.cmd) || null;
    out.push({
      cardId: card.id,
      name: card.name || launch.subject || '(untitled)',
      verifyCmd,
      // "not machine-verifiable" is an honest, reportable outcome — the recheck
      // never invents a command for a card whose criteria was prose.
      // Reason precedence is unchanged from before this fix: the
      // dispatch-captured verifyReason still wins whenever nothing new armed,
      // so a card that was unverifiable before and is unverifiable now reports
      // the identical string it always did. The gate's own reason is only a
      // backstop for a launch row that recorded neither a command nor a reason.
      reason: verifyCmd
        ? null
        : (launch.verifyReason || (fallback && fallback.reason) || 'no verify command was captured at dispatch'),
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

// ── Open-backlog acceptance sweep (BRO-3551) ────────────────────────────────
//
// selectRecheckTargets above answers "did a CLAIMED fix hold" — Done/Paused
// cards a session already closed. This answers a cheaper, upstream question:
// among cards NEVER dispatched at all, which ones are already fixed on main,
// by other work, and just never got closed? BRO-2511 is the motivating
// case — hand-dispatched, closed in 1m53s having written zero code, because
// both cited failures were already fixed. Its own acceptance command would
// have answered that in 0.5s.
//
// The funnel is deliberately the SAME gate bsc-next.js/linear-next.js apply
// before spending a session on a card (autofixFiledIssueGuard, then
// classifyHeadlessDispatchability's five blockers) — not a new, looser
// "looks abandoned" heuristic. A card this predicate selects is one a human
// or headless dispatch would otherwise have paid a full session to discover
// was already done.
//
// Priority numbers per linear-import-rules.js's TIER_TO_LINEAR (P0:1, P1:2,
// P2:3, P3:4) — one mapping, not re-guessed here (CLAUDE.md §15).
const OPEN_BACKLOG_SWEEP_PRIORITIES = Object.freeze([2, 3]); // P1, P2
// Linear's non-started workflow-state types — "Backlog" and "Todo" in this
// team's UI. Deliberately excludes 'started' (In Progress/In Review): a card
// someone already has hands on is not this sweep's population.
const OPEN_BACKLOG_SWEEP_STATE_TYPES = Object.freeze(['backlog', 'unstarted']);

/**
 * Which OPEN P1/P2 Backlog/Todo issues are candidates for "run its own
 * acceptance command — it may already pass".
 *
 * SHADOW/report-only by construction: this never mutates a card, it only
 * decides who is a candidate FOR the runner (scripts/sweep-open-backlog-
 * acceptance.js) to execute a command for and report on.
 *
 * @param {object} o
 * @param {{id:string,name:string,priority:number,stateType:string,notes?:string,comments?:string[]}[]} o.issues
 *   - shape produced by linear-open-backlog-source.js's mapIssueToCandidate
 * @param {(issueId:string)=>boolean} [o.isClaimed] - a card someone is
 *   actively working right now is excluded — reporting "already done" on a
 *   card mid-fix is confusing, and this sweep never dispatches anyway, so
 *   there is no cost to leaving it out.
 * @param {number[]} [o.priorities]
 * @param {string[]} [o.stateTypes]
 * @returns {{cardId:string,name:string,verifyCmd:string}[]}
 */
function selectOpenBacklogSweepCandidates({
  issues,
  isClaimed = () => false,
  priorities = OPEN_BACKLOG_SWEEP_PRIORITIES,
  stateTypes = OPEN_BACKLOG_SWEEP_STATE_TYPES,
} = {}) {
  const out = [];
  for (const issue of issues || []) {
    if (!issue || !issue.id) continue;
    if (!priorities.includes(Number(issue.priority))) continue;
    if (!stateTypes.includes(issue.stateType)) continue;
    if (isClaimed(issue.id)) continue;
    // autofixFiledIssueGuard: the pipeline that filed this issue already
    // owns dispatching it — a sweep reporting on it either duplicates a live
    // dispatch's own verdict or describes a rolling health snapshot as "a
    // backlog card", neither of which this sweep exists to do.
    if (autofixFiledIssueGuard({ identifier: issue.id, title: issue.name, description: issue.notes }, {})) continue;

    const comments = Array.isArray(issue.comments) ? issue.comments : [];
    const gate = evaluateVerifiability(issue.notes || '', comments);
    if (!gate.cmd) continue; // no safe-form acceptance command — nothing to run

    const headless = classifyHeadlessDispatchability(
      { subject: issue.name, notes: issue.notes },
      { verifyCmd: gate.cmd }
    );
    if (!headless.dispatchable) continue;

    out.push({ cardId: issue.id, name: issue.name || '(untitled)', verifyCmd: gate.cmd });
  }
  return out;
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
  OPEN_BACKLOG_SWEEP_PRIORITIES,
  OPEN_BACKLOG_SWEEP_STATE_TYPES,
  selectOpenBacklogSweepCandidates,
};
