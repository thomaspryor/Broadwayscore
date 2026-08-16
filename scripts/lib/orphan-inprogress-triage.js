/**
 * orphan-inprogress-triage.js — pure classification for LIVE `in_progress`
 * shared-task-list entries that have no matching cmux workspace (task #1705).
 *
 * Sibling of task-reclaim.js's classifyReclaimable(), NOT a reimplementation:
 * it reuses that module's leaf predicates (notionMarkerOf, isBscDaily,
 * TERMINAL_CARD_STATUSES, DEFAULT_IDLE_MS) but needs its own decision tree
 * because the population is different in a way that breaks classifyReclaimable's
 * assumptions. classifyReclaimable's first guards (`live.ids.has(id)`,
 * `skip-duplicate-live`) exist to disambiguate an ARCHIVE-resident record from
 * its LIVE twin — every task this module classifies IS the live record, so
 * that disambiguation is meaningless here (it would spuriously fire on every
 * input). What carries over unchanged is the SAFETY POSTURE: never claim
 * FINISHED without corroborating evidence, never reclaim work that might
 * still be in flight, default to the most conservative bucket when unsure.
 *
 * Card #1705's specific ask — a REPORTED split (FINISHED vs LOST vs STALE),
 * not just a raw count reduction — is why this adds a fourth bucket
 * classifyReclaimable doesn't have: NEEDS-REVIEW. A card whose Notion Outcome
 * describes finished work is not proof by itself (task #1272's own finding:
 * Outcome text can be stale, wrong, or describe a still-negotiated plan) —
 * FINISHED here requires the outcome to be CORROBORATED by a commit that
 * references the task, matching the standard the #1702 sample in card #1705
 * was verified against by hand. Uncorroborated-but-plausible cases park as
 * NEEDS-REVIEW rather than being guessed either FINISHED or LOST.
 */

'use strict';

const {
  notionMarkerOf,
  isBscDaily,
  TERMINAL_CARD_STATUSES,
  DEFAULT_IDLE_MS,
} = require('./task-reclaim.js');
const { hasOwnerJudgmentMarker } = require('./owner-judgment-marker.js');

/**
 * @param {Array<object>} tasks               in_progress tasks with no live workspace match
 * @param {object} ctx
 * @param {Set<string>} [ctx.startedIds]       ids with a real dispatch-ledger start event
 * @param {(id:string)=>{hasEvidence:boolean,matches:string[]}} [ctx.branchEvidenceOf]
 * @param {(id:string)=>{hasEvidence:boolean,commits:string[]}} [ctx.gitEvidenceOf]
 * @param {(card:object)=>{hasEvidence:boolean,evidence:string[]}} [ctx.corroborateOutcomeOf]
 *        stronger-than-#id evidence for a card's Outcome text: does it name a
 *        keyFile that exists, or a commit hash that resolves? #1159 in the
 *        real backlog is the reason this exists — its Outcome names commit
 *        46bc0384 and 3 keyFiles, all real, but the commit message never
 *        contains "#1159" (the card's own title cites a DIFFERENT number,
 *        "card #1158", from the bug-tracker this repo migrated off of) — a
 *        plain #id grep misses genuinely finished work like this outright.
 * @param {(markerId:string)=>(object|null)} [ctx.cardOf]   null = fetch failed
 * @param {number} ctx.now
 * @param {number} [ctx.idleMs]
 * @returns {Array<{id, subject, bucket, action, reason, notionId, cardStatus, commits, branches}>}
 */
function classifyOrphanInProgress(tasks, ctx = {}) {
  const {
    startedIds = new Set(),
    branchEvidenceOf = () => ({ hasEvidence: false, matches: [] }),
    gitEvidenceOf = () => ({ hasEvidence: false, commits: [] }),
    corroborateOutcomeOf = () => ({ hasEvidence: false, evidence: [] }),
    cardOf = () => null,
    now = 0,
    idleMs = DEFAULT_IDLE_MS,
  } = ctx;

  const out = [];
  for (const task of tasks || []) {
    if (!task) continue;
    const id = String(task.id);
    const push = (bucket, action, reason, extra = {}) =>
      out.push({ id, subject: task.subject || '', bucket, action, reason, ...extra });

    if (isBscDaily(task)) {
      push('STALE', 'close-superseded', 'BSC Daily alert card — the digest re-mints these daily and files to Linear now, so this copy is superseded');
      continue;
    }

    const git = gitEvidenceOf(id);
    const marker = notionMarkerOf(task);

    if (!marker) {
      if (git.hasEvidence) {
        push('FINISHED', 'git-evidence', `no Notion card, but a commit references #${id}`, { commits: git.commits });
        continue;
      }
      // No Notion card to check an Outcome/keyFiles/idle signal against, so
      // an unmerged branch is the ONLY evidence source left for a marker-less
      // task — and a real one exists in the corpus (#1147: description says
      // in so many words "branch pushed to origin, NOT merged to main").
      // Skipping this check would reclaim it to pending and let a fresh
      // session redo (or worse, conflict with) real unlanded work.
      const ev = branchEvidenceOf(id);
      if (ev.hasEvidence) {
        push('NEEDS-REVIEW', 'park-started', `no Notion card, but a branch/worktree still exists — may hold unmerged work (${ev.matches.join(', ')})`, { branches: ev.matches });
      } else {
        push('LOST', 'reclaim', 'no Notion card to consult, no commit references this task, and no branch/worktree evidence — unambiguously stale');
      }
      continue;
    }

    const card = cardOf(marker);
    if (!card) {
      push('NEEDS-REVIEW', 'card-unavailable', 'Notion card could not be fetched — refusing to act blind', { notionId: marker });
      continue;
    }

    const cardStatus = card.status || null;
    if (cardStatus === 'Done') {
      push('FINISHED', 'card-done', 'Notion card status is Done', { notionId: marker, cardStatus });
      continue;
    }
    if (TERMINAL_CARD_STATUSES.has(cardStatus) && cardStatus !== 'Done') {
      push('STALE', 'card-terminal', `Notion card status is ${cardStatus}`, { notionId: marker, cardStatus });
      continue;
    }

    // The freshness gate exists to protect a card someone might be actively
    // working RIGHT NOW — but "Paused" is never that state (a live session
    // reads "In progress"; Paused is the OUTCOME_PARK_MARKER convention's own
    // "stop, needs a human" signal — bsc-reconcile.js's sweepUntrackedInProgress
    // sets it deliberately to hand a card off, not to claim active work).
    // Measured on the real backlog (task #1705): 53 of 73 initially-ambiguous
    // cards were Paused by that exact sweep 45-47h earlier, clustering just
    // under a 48h bar and making every one of them read "someone may still be
    // on it" when the opposite was true — the sweep had ALREADY decided nobody
    // was and was waiting on exactly the adjudication this module performs.
    // Gating Paused cards on edit recency would block this task's whole
    // purpose on the timestamp of its own precondition.
    if (cardStatus !== 'Paused') {
      const idle = card.lastEditedAt ? now - Date.parse(card.lastEditedAt) : NaN;
      if (!Number.isFinite(idle)) {
        push('NEEDS-REVIEW', 'card-unavailable', 'card has no usable lastEditedAt — cannot tell whether anyone is on it', { notionId: marker, cardStatus });
        continue;
      }
      if (idle < idleMs) {
        push('NEEDS-REVIEW', 'skip-fresh', `card was edited ${(idle / 3600e3).toFixed(1)}h ago — someone may still be on it`, { notionId: marker, cardStatus });
        continue;
      }
    }

    const hasOutcome = Boolean(String(card.outcome || '').trim());

    // A card can ship real, verifiable code AND still be correctly held open
    // — CLAUDE.md's own RECHECK-AFTER convention: "a fix whose effect is
    // only observable later may NOT be claimed Done." Card #586 in the real
    // backlog is the exact trap: keyFiles/commits corroborate real shipped
    // work, but its own latest Outcome entry explains IN WORDS why it must
    // stay Paused (two acceptance criteria are live-traffic numbers, gated by
    // RECHECK-AFTER 2026-08-18/24, neither past yet) — corroboration alone
    // would have force-closed it wrong. A future RECHECK-AFTER date is a
    // structured, unambiguous signal that beats prose-sniffing for "do not
    // close" language, so it is checked first and wins outright: it is
    // checked even ahead of the duplicate/superseded guard below, and skips
    // corroboration entirely.
    if (hasOutcome) {
      const recheckDates = [...String(card.outcome).matchAll(/RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/gi)]
        .map((m) => Date.parse(m[1]))
        .filter(Number.isFinite);
      const pending = recheckDates.some((d) => d > now);
      if (pending) {
        push('NEEDS-REVIEW', 'recheck-after-pending', 'card records a completed-looking Outcome, but it names a RECHECK-AFTER date that has not passed yet — the card\'s own words say this cannot be claimed Done until then', { notionId: marker, cardStatus });
        continue;
      }
    }

    // Same class of guard as RECHECK-AFTER above, ship-check adversarial
    // catch (task #1705): "VERIFY: owner-judgment" (scripts/lib/owner-
    // judgment-marker.js) is this codebase's OTHER "only a human can confirm
    // this" convention — used by verify-gate.js and headless-dispatchability.js
    // to block an unattended dispatch/completion claim. A corroborated
    // Outcome carrying that marker must never sail through to FINISHED the
    // same way an uncaught RECHECK-AFTER almost did.
    if (hasOutcome && hasOwnerJudgmentMarker(card.outcome)) {
      push('NEEDS-REVIEW', 'owner-judgment-pending', 'card is marked VERIFY: owner-judgment — its result cannot be machine-checked, needs a human yes/no, not an automatic close', { notionId: marker, cardStatus });
      continue;
    }

    // A card whose own Outcome points at a DIFFERENT card as the record of
    // truth is superseded-by-reference — the real work (if any) is tracked
    // there, and neither a git-evidence hit nor a keyFile check is the right
    // question to ask about this satellite record. Four shapes seen in the
    // backlog this was built against: "Duplicate of ..." (#1160), "Duplicate
    // session card ..." (#1273), "... — see main card #N" (#1274), and
    // "Deprioritised ... do NOT auto-dispatch" (#1258, an explicit owner
    // stand-down, not an accident of dispatch plumbing).
    const outcomeLower = String(card.outcome || '').toLowerCase();
    const isSuperseded = /\b(duplicate (?:of|session card)|main card)\b/i.test(card.outcome)
      || (outcomeLower.includes('deprioriti') && outcomeLower.includes('do not auto-dispatch'));
    if (hasOutcome && isSuperseded) {
      push('STALE', 'card-superseded', 'card\'s own Outcome points elsewhere as the record of truth (duplicate/see-main-card) or records an explicit owner stand-down — not this card\'s own work to verify', { notionId: marker, cardStatus });
      continue;
    }

    if (hasOutcome) {
      const corroboration = corroborateOutcomeOf(card);
      if (git.hasEvidence || corroboration.hasEvidence) {
        const evidence = git.hasEvidence ? git.commits : corroboration.evidence;
        push('FINISHED', 'outcome-corroborated', `card records a completed Outcome, corroborated by ${git.hasEvidence ? 'a commit referencing this task' : corroboration.evidence.join('; ')}`, { notionId: marker, cardStatus, commits: evidence });
      } else {
        push('NEEDS-REVIEW', 'park-outcome', 'card already records a completed Outcome, but nothing in it (keyFiles, commit hash) could be corroborated against the repo — needs a human yes/no, not an automatic close', { notionId: marker, cardStatus });
      }
      continue;
    }

    // No Outcome recorded.
    if (startedIds.has(id)) {
      const ev = branchEvidenceOf(id);
      push('NEEDS-REVIEW', 'park-started', ev.hasEvidence
        ? `dispatched before and a branch/worktree still exists — may hold uncommitted work (${ev.matches.join(', ')})`
        : 'dispatched before with no outcome recorded; branch detection cannot prove absence of leftover work',
        { notionId: marker, cardStatus, branches: ev.matches });
      continue;
    }

    push('LOST', 'reclaim', 'never dispatched (no ledger start event), card has no Outcome and is not terminal — genuinely orphaned claim', { notionId: marker, cardStatus });
  }
  return out;
}

module.exports = { classifyOrphanInProgress };
