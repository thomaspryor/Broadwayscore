/**
 * autonomous-verify-cmd.js — pull the one runnable command that proves a card
 * is done out of the card's own acceptance criteria (Sprint 3, S3-T1).
 *
 * Why: "Done" on a Notion card is currently a claim by whoever closed it. The
 * nightly acceptance recheck (scripts/autonomous-acceptance-recheck.js) turns
 * that into a fact by RE-RUNNING the card's own stated check against a fresh
 * checkout of main. That only works if the command was captured at dispatch
 * time, when the card text is in hand — hours or days before anything is
 * marked Done.
 *
 * Card notes are UNTRUSTED (anyone, including an LLM, can write them) and this
 * string is later EXECUTED, so every candidate goes through the same
 * isSafeCheckCommand gate the triage queue uses — injected, so this module
 * stays dependency-free and testable. A card whose acceptance criteria is
 * prose, or whose command fails validation, records verifyCmd: null with a
 * stated reason: "not machine-verifiable" is an honest answer and the recheck
 * lists it as such. Guessing a plausible command would be worse than nothing —
 * it would manufacture green rechecks for work nobody verified.
 *
 * Named autonomous-* on purpose: the loop's own eligibility gate refuses to
 * edit scripts/lib/autonomous-*, so a tier-3 card can never rewrite the thing
 * that audits its own completion.
 *
 * BRO-2585: a `VERIFY: <cmd>` line's own remainder is a candidate even
 * without backticks — that's the form cards are actually written in. It
 * takes the WHOLE line as one candidate (no trailing "passes"/"# comment"
 * tolerance — fails closed, unarmed, same as before this existed), and goes
 * through the identical isSafeCheckCommand gate as every backticked
 * candidate, so it can never arm anything a backticked span couldn't. It
 * does not require the VERIFY: line to sit inside "## Acceptance criteria"
 * — that scope was already true for backticked VERIFY lines before this
 * change (see VERIFY_LINE_RE below, which scans the whole text).
 */

'use strict';

// Specificity of a runnable command, lowest wins. A card that lists both
// `node --test tests/unit/thing.test.mjs` and `npx tsc --noEmit` was having
// the tsc line captured purely because it appeared first — and "tsc still
// passes" says nothing about whether THAT card's work survived (ship-check
// finding). Module-level (not local to extractVerifyCmd) and exported so
// autonomous-recheck-core.js can rank a comment-posted correction against a
// dispatch-ledger snapshot the same way (BRO-3446) — CLAUDE.md §15: this is
// the one copy, never re-implement the ranking elsewhere.
const rank = c => (/^node --test/.test(c) || /^npx tsx --test/.test(c) ? 0 : /^test -f/.test(c) ? 1 : 2);

// Where a runnable command legitimately lives on a card. Both are conventions
// this repo's cards already follow (see the plan-tasks skill output format).
const SECTION_RE = /##\s*Acceptance criteria\s*\n([\s\S]*?)(?=\n##|$)/i;
const VERIFY_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?VERIFY(?:\*\*)?:\s*(.+)$/gim;

// Commands appear as backticked spans (`node --test x.test.mjs`) far more
// often than bare, and a bare line is usually prose ABOUT a command.
function candidatesFrom(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

/**
 * Every runnable-command candidate in `text`, in the order it appears —
 * backticked spans inside an `## Acceptance criteria` section, plus each
 * `VERIFY: <cmd>` line's own remainder (BRO-2585) — UNFILTERED by
 * isSafeCheckCommand and UNSORTED by rank(). Exported so a caller that needs
 * a DIFFERENT selection policy over the same candidates can reuse the
 * extraction instead of re-implementing SECTION_RE/VERIFY_LINE_RE a second
 * time (CLAUDE.md §15).
 *
 * BRO-3446: findCommentCorrection (autonomous-recheck-core.js) is exactly
 * this case. Tested against the real BRO-3382 correction comment — "The
 * acceptance comment says: VERIFY: <phantom path> ... So the correct command
 * for this card is: VERIFY: <real path>" — extractVerifyCmd's own
 * first-at-best-rank policy below picks the QUOTED PHANTOM, because both
 * candidates tie at rank 0 and it appears first. A correction comment
 * routinely restates the wrong path for context before the right one, so
 * findCommentCorrection needs the LAST safe candidate at the best rank, not
 * the first — a real false-negative this ticket's own motivating card
 * surfaced, not a hypothetical.
 * @param {string} text
 * @returns {string[]}
 */
function rawCandidates(text) {
  const s = String(text || '');
  const scoped = [];
  const verifyLineRaw = [];
  const section = SECTION_RE.exec(s);
  if (section) scoped.push(section[1]);
  for (const m of s.matchAll(VERIFY_LINE_RE)) {
    scoped.push(m[1]);
    verifyLineRaw.push(m[1]);
  }
  if (!scoped.length) return [];
  return [...scoped.flatMap(candidatesFrom), ...verifyLineRaw]
    // `$ node --test x` and `> npx tsc` are shell-prompt decoration.
    .map(c => c.trim().replace(/^[$>]\s*/, ''))
    .filter(Boolean);
}

/**
 * @param {string} notes - the card's full notes/body
 * @param {(cmd:string)=>boolean} isSafeCheckCommand - injected validator
 * @param {(cmd:string)=>{kind:string|null}} [explainUnsafeCheckCommand] - optional
 *   injected diagnostic (autonomous-triage-core.js). When provided, a refusal
 *   carries `kind` (one of 'no-section' | 'no-command' | the SAFE_CHECK_FORMS
 *   kinds — 'shape' | 'path-prefix' | 'traversal' | 'mutating-script' |
 *   'basename') so callers can distinguish "wrong directory" from "wrong
 *   shape" from "no command at all" instead of one opaque reason string
 *   (BRO-2570 — audit-card-verifiability.js reported one refusal reason
 *   board-wide; this is what lets it report WHY). Optional and separate from
 *   isSafeCheckCommand so this module stays dependency-free when a caller
 *   doesn't need the breakdown.
 * @returns {{cmd: string|null, reason: string|null, kind?: string|null}}
 */
function extractVerifyCmd(notes, isSafeCheckCommand, explainUnsafeCheckCommand) {
  const text = String(notes || '');
  // Cards are routinely written as `VERIFY: node --test x.test.mjs` — no
  // backticks — despite candidatesFrom() being backtick-only (BRO-2585). A
  // raw VERIFY line still goes through the identical isSafeCheckCommand gate
  // below via rawCandidates(), so it can never arm anything a backticked
  // span couldn't.
  //
  // VERIFY_LINE_RE carries the `g` flag, so `.test()` on it directly would
  // mutate its shared lastIndex and corrupt every later call in this
  // process — text.matchAll() is the non-mutating way to ask "any match at
  // all" (it operates on an internal clone, per spec).
  const hasScope = Boolean(SECTION_RE.exec(text)) || !text.matchAll(VERIFY_LINE_RE).next().done;
  if (!hasScope) return { cmd: null, reason: 'card has no acceptance-criteria section or VERIFY line', kind: 'no-section' };

  const candidates = rawCandidates(text);
  if (!candidates.length) return { cmd: null, reason: 'acceptance criteria names no runnable command (prose only)', kind: 'no-command' };

  // Prefer the SPECIFIC command over the generic one, via the module-level
  // rank() above. Ranked, not reordered: order within a rank is still card order.
  const safe = candidates.filter(c => isSafeCheckCommand(c));
  if (safe.length) {
    const best = safe.slice().sort((a, b) => rank(a) - rank(b))[0];
    return { cmd: best, reason: null };
  }
  const kind = typeof explainUnsafeCheckCommand === 'function'
    ? explainUnsafeCheckCommand(candidates[0]).kind
    : null;
  return {
    cmd: null,
    reason: `no acceptance-criteria command passed safe-form validation (first candidate: ${candidates[0].slice(0, 120)})`,
    kind,
  };
}

module.exports = { extractVerifyCmd, candidatesFrom, SECTION_RE, rank, rawCandidates };
