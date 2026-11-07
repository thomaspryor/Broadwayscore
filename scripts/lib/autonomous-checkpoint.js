/**
 * autonomous-checkpoint.js — multi-night incremental checkpointing for L
 * (too-big-for-one-night) cards (Sprint 3, S3-T4).
 *
 * v4's original plan had L cards proposing a human-approved split into child
 * cards; the owner killed that UX (2026-07-12: "no child cards, no
 * Accept-split button"). Instead an L card is worked INCREMENTALLY: each
 * night gets exactly one S-sized budget slice (scripts/lib/autonomous-budget.js
 * ENVELOPES.L), reusing the SAME branch across nights. A night that makes
 * genuine progress but doesn't finish is a CHECKPOINT, not a failure — the
 * card gets a note and stays in the loop's queue (Auto→'queued') instead of
 * being marked failed and returned to the human backlog.
 *
 * Pure decision helpers only — the executor (scripts/autonomous-run.js) owns
 * all git/Notion/ledger side effects.
 */

'use strict';

function isIncrementalSize(size) {
  return size === 'L';
}

// Distinguishes "safe, incomplete progress" from "actually broken": on an L
// card, if every check passed EXCEPT the card's own checkableDone check
// (i.e. nothing the implementer touched broke, it just isn't done yet), the
// night is a checkpoint. Any other failing check (colocated tests, tsc) is a
// genuine failure — an L card gets no special leniency for broken tests.
//
// hasCheckableDone (opts): an L card with NO checkableDone at all has no
// signal that proves it's actually finished — tsc/colocated-tests merely
// passing doesn't mean "done" for a card explicitly sized too-big-for-one-
// night. Without this, a large card could be marked complete after a single
// harmless commit (ship-check finding, 2026-07-14). Default true preserves
// prior behavior for callers that don't pass it (normal-size cards always do).
function classifyLCardOutcome(checks, { hasCheckableDone = true } = {}) {
  const list = checks || [];
  if (!list.length) return 'failed'; // no checks ran at all — treat as broken, not incomplete
  const failed = list.filter(c => !c.pass);
  if (!failed.length) return hasCheckableDone ? 'done' : 'checkpoint';
  const onlyCardCheckFailed = failed.length === 1 && /^card-check\b/.test(failed[0].name || '');
  return onlyCardCheckFailed ? 'checkpoint' : 'failed';
}

// How many checkpoint rounds has this card already had? Parsed from the
// card's own outcome text (the durable, Notion-hosted record) so a fresh
// executor process on a new night picks up numbering correctly.
const CHECKPOINT_HEADER_RE = /##\s*Autonomous checkpoint \(night (\d+)\)/gi;

function nightNumberFor(outcomeText) {
  let max = 0;
  const text = String(outcomeText || '');
  let m;
  CHECKPOINT_HEADER_RE.lastIndex = 0;
  while ((m = CHECKPOINT_HEADER_RE.exec(text))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// Prompt addendum for a RESUMED L card — prepended to the normal
// buildImplementerPrompt() output (scripts/lib/autonomous-run-core.js) when
// the executor finds an existing checkpoint branch for this card.
function buildResumeNote(card, priorOutcome) {
  const night = nightNumberFor(priorOutcome);
  return [
    `This is a MULTI-NIGHT card — night ${night}. A previous night already made progress on the SAME branch (you are resuming it, not starting fresh).`,
    ``,
    `Progress so far (from the card's own record):`,
    (priorOutcome || '(no prior checkpoint note found — proceed as if this were night 1)'),
    ``,
    `Continue from where the last night left off. If you finish everything the card asks for tonight, say so clearly. If not, make as much safe, in-bounds progress as fits in tonight's budget, commit it, and end your summary with exactly what remains for tomorrow night — that summary becomes the next checkpoint note.`,
  ].join('\n');
}

// First-night-on-an-L-card addendum (no prior branch yet).
function buildFirstNightNote() {
  return [
    `This is a LARGE card — do not try to finish it all tonight. You get one small budget slice per night; the loop will resume this SAME branch again tomorrow if you don't finish.`,
    `Make as much safe, in-bounds progress as fits in tonight's budget, commit it, and end your summary with exactly what remains — that summary becomes tomorrow night's checkpoint note.`,
  ].join('\n');
}

// The note appended to the card's Outcome (via notion-brain --outcome) after
// a checkpoint night. Pure text builder — the executor supplies the
// implementer's own summary.
function buildCheckpointNote({ night, summary, branch }) {
  return `## Autonomous checkpoint (night ${night})\n${String(summary || '(no summary given)').slice(0, 800)}\n\nBranch: ${branch} — not yet complete, resuming next run.`;
}

module.exports = {
  isIncrementalSize,
  classifyLCardOutcome,
  nightNumberFor,
  buildResumeNote,
  buildFirstNightNote,
  buildCheckpointNote,
};
