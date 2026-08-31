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
 */

'use strict';

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
  const scoped = [];
  const verifyLineRaw = [];
  const section = SECTION_RE.exec(text);
  if (section) scoped.push(section[1]);
  for (const m of text.matchAll(VERIFY_LINE_RE)) {
    scoped.push(m[1]);
    // Cards are routinely written as `VERIFY: node --test x.test.mjs` — no
    // backticks — despite candidatesFrom() being backtick-only (BRO-2585).
    // The line's own remainder is a candidate in its own right here, not just
    // whatever backticked span it happens to contain; still run through the
    // same isSafeCheckCommand gate below, so a raw VERIFY line can never arm
    // anything a backticked one couldn't.
    verifyLineRaw.push(m[1]);
  }
  if (!scoped.length) return { cmd: null, reason: 'card has no acceptance-criteria section or VERIFY line', kind: 'no-section' };

  const candidates = [...scoped.flatMap(candidatesFrom), ...verifyLineRaw]
    // `$ node --test x` and `> npx tsc` are shell-prompt decoration.
    .map(c => c.trim().replace(/^[$>]\s*/, ''))
    .filter(Boolean);
  if (!candidates.length) return { cmd: null, reason: 'acceptance criteria names no runnable command (prose only)', kind: 'no-command' };

  // Prefer the SPECIFIC command over the generic one. A card that lists both
  // `node --test tests/unit/thing.test.mjs` and `npx tsc --noEmit` was having
  // the tsc line captured purely because it appeared first — and "tsc still
  // passes" says nothing about whether THAT card's work survived (ship-check
  // finding). Ranked, not reordered: order within a rank is still card order.
  const rank = c => (/^node --test/.test(c) || /^npx tsx --test/.test(c) ? 0 : /^test -f/.test(c) ? 1 : 2);
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

module.exports = { extractVerifyCmd, candidatesFrom, SECTION_RE };
