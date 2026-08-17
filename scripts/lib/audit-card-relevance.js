/**
 * audit-card-relevance.js — pure classifier answering "is this open P1 card
 * still real?" (task #1719).
 *
 * Nothing in the repo has ever swept the open-P1 pool for staleness.
 * scripts/audit-card-verifiability.js checks whether a card is DISPATCHABLE
 * (has a safe-form acceptance command) — it says nothing about whether the
 * work is still needed. This module is the classifier the health-check /
 * digest infra was missing: for every open P1 it emits one of four verdicts,
 * each backed by concrete evidence, never by a heuristic guess:
 *
 *   LIKELY-DONE      — the card's own acceptance command passes right now,
 *                       OR every commit SHA it names is already an ancestor
 *                       of origin/main, OR its RECHECK-AFTER date has passed
 *                       with a filled Outcome and the acceptance still holds.
 *   LIKELY-DUPLICATE — high title-token overlap with another open card, or
 *                       it names the same file AND the same symbol as one.
 *   LIKELY-STALE     — every file/script its notes name no longer exists.
 *   REAL             — everything else. Default. Ambiguity is REAL, never
 *                       closed — ONLY a human reopens the "is this stale"
 *                       question, this module never mutates a card.
 *
 * Every filesystem/git/exec check is INJECTED (opts.runAcceptanceCmd,
 * opts.isCommitOnMain, opts.fileExists) so this file stays pure and testable
 * per CLAUDE.md §15 — the CLI wrapper (scripts/audit-card-relevance.js)
 * supplies the real implementations.
 */
'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { RECHECK_AFTER_RE } = require('./recheck-stamp.js');
const { foldDiacritics } = require('./title-match.js');

// ── LIKELY-DONE: acceptance command ─────────────────────────────────────
// Reuses the SAME extractor bsc-next.js's dispatch gate uses (verify-gate.js
// → autonomous-verify-cmd.js), so "this card names a runnable command" can
// never drift between "would bsc-next dispatch it" and "does the classifier
// think it's already satisfied".
function checkAcceptanceHolds(card, opts) {
  const { cmd } = evaluateVerifiability(card.notes || '');
  if (!cmd || typeof opts.runAcceptanceCmd !== 'function') return null;
  const result = opts.runAcceptanceCmd(cmd);
  if (result && result.status === 'pass') {
    return { type: 'acceptance-command-passes', cmd, detail: result.detail || null };
  }
  return null;
}

// ── LIKELY-DONE: commit SHAs already on main ────────────────────────────
// Deliberately narrow: a bare hex-looking token in prose ("issue a1b2c3d")
// is not evidence, so a SHA only counts when it appears backticked or right
// after a "commit"/"sha" label — the same "backtick or explicit label" bar
// autonomous-verify-cmd.js uses for command candidates.
const BACKTICKED_SHA_RE = /`([0-9a-f]{7,40})`/gi;
const LABELED_SHA_RE = /\b(?:commit|sha)s?:?\s+([0-9a-f]{7,40})\b/gi;

function extractCommitShas(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(BACKTICKED_SHA_RE)) out.add(m[1].toLowerCase());
  for (const m of s.matchAll(LABELED_SHA_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

function checkCommitsOnMain(card, opts) {
  const text = `${card.notes || ''}\n${card.outcome || ''}`;
  const shas = extractCommitShas(text);
  if (!shas.length || typeof opts.isCommitOnMain !== 'function') return null;
  const allOnMain = shas.every((sha) => opts.isCommitOnMain(sha));
  if (!allOnMain) return null;
  return { type: 'commits-on-main', shas };
}

// ── LIKELY-DONE: RECHECK-AFTER due + Outcome filled + acceptance holds ──
// Reuses recheck-stamp.js's canonical RECHECK_AFTER_RE (fixed 2026-08-14 to
// make the colon optional — live cards are hand-stamped `RECHECK-AFTER
// 2026-08-24` with no colon) instead of a second copy that would silently
// under-match colon-less stamps (CLAUDE.md §15 reuse rule).
function extractRecheckAfter(text) {
  const m = RECHECK_AFTER_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

function checkRecheckAfterDueAndVerified(card, opts) {
  const text = `${card.notes || ''}\n${card.outcome || ''}`;
  const date = extractRecheckAfter(text);
  if (!date) return null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dueAt = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(dueAt) || dueAt > now.getTime()) return null; // not due yet, or unparsable
  if (!card.outcome || !String(card.outcome).trim()) return null; // no filled Outcome — nothing to hold
  // "the acceptance still holds" is answered by the SAME acceptance-command
  // check as checkAcceptanceHolds — a RECHECK-AFTER stamp with no runnable
  // command names no bar this classifier can confirm, so it stays ambiguous.
  const { cmd } = evaluateVerifiability(card.notes || '');
  if (!cmd || typeof opts.runAcceptanceCmd !== 'function') return null;
  const result = opts.runAcceptanceCmd(cmd);
  if (result && result.status === 'pass') {
    return { type: 'recheck-after-due-and-verified', recheckAfter: date, cmd };
  }
  return null;
}

function checkLikelyDone(card, opts) {
  return checkAcceptanceHolds(card, opts)
    || checkCommitsOnMain(card, opts)
    || checkRecheckAfterDueAndVerified(card, opts);
}

// ── LIKELY-DUPLICATE ─────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'with', 'is',
  'are', 'be', 'been', 'was', 'were', 'p0', 'p1', 'p2', 'fix', 'bug', 'card',
  'task', 'still', 'this', 'that', 'never', 'not', 'has', 'have', 'it', 'its',
]);

// Fold diacritics BEFORE stripping non-ASCII (task #648 class, structural
// guard: tests/unit/sibling-matchers-diacritics.test.mjs) — cards are titled
// after real shows, and this repo has a documented history of title-matching
// bugs from exactly this order (Schmigadoon!, O'Hara). An unfolded strip
// would turn "Café" into "caf" instead of "cafe", silently splitting a
// duplicate pair that should have matched.
function tokenizeTitle(name) {
  return foldDiacritics(String(name || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Jaccard similarity over the token sets. 0 when either title has no
// significant tokens (a bare-number or symbol-only "title" can't overlap
// meaningfully with anything).
function titleOverlapScore(a, b) {
  const ta = new Set(tokenizeTitle(a));
  const tb = new Set(tokenizeTitle(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

const TITLE_OVERLAP_THRESHOLD = 0.6;
const TITLE_MIN_TOKENS = 3;

// Repo-relative file paths named in card prose — same root-dir allowlist
// autonomous-triage-core.js's SAFE_CHECK_FORMS pathPrefix uses.
const FILE_REF_RE = /\b(?:scripts|src|data|tests)\/[\w./-]+\.(?:m?js|ts|tsx|json)\b/g;
// Backticked bare identifiers — `evaluateVerifiability`, `runVerify`, etc.
// Deliberately excludes anything containing '/' or '(' so it never doubles
// up with FILE_REF_RE or a command candidate.
const SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

function extractFileRefs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(FILE_REF_RE)) out.add(m[0]);
  return out;
}

function extractSymbols(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(SYMBOL_RE)) out.add(m[1]);
  return out;
}

function hasIntersection(setA, setB) {
  for (const v of setA) if (setB.has(v)) return true;
  return false;
}

// Finds the strongest duplicate signal for `card` against the rest of the
// pool. File+symbol overlap is checked first — it is concrete evidence (two
// cards both naming the exact same function in the exact same file) rather
// than the fuzzier title-token heuristic, so it wins when both are present.
function findDuplicateForCard(card, allCards) {
  const fileRefsA = extractFileRefs(card.notes);
  const symbolsA = extractSymbols(card.notes);
  if (fileRefsA.size && symbolsA.size) {
    for (const other of allCards) {
      if (!other || other.id === card.id) continue;
      const fileRefsB = extractFileRefs(other.notes);
      if (!hasIntersection(fileRefsA, fileRefsB)) continue;
      const symbolsB = extractSymbols(other.notes);
      if (!hasIntersection(symbolsA, symbolsB)) continue;
      return { type: 'duplicate-file-symbol', otherId: other.id, otherName: other.name, otherUrl: other.url || null };
    }
  }
  const tokensA = tokenizeTitle(card.name);
  if (tokensA.length >= TITLE_MIN_TOKENS) {
    let best = null;
    for (const other of allCards) {
      if (!other || other.id === card.id) continue;
      const tokensB = tokenizeTitle(other.name);
      if (tokensB.length < TITLE_MIN_TOKENS) continue;
      const score = titleOverlapScore(card.name, other.name);
      if (score >= TITLE_OVERLAP_THRESHOLD && (!best || score > best.score)) {
        best = { type: 'duplicate-title-overlap', otherId: other.id, otherName: other.name, otherUrl: other.url || null, score: Math.round(score * 100) / 100 };
      }
    }
    if (best) return best;
  }
  return null;
}

// ── LIKELY-STALE ─────────────────────────────────────────────────────────
// A looser path pattern than FILE_REF_RE (also matches directories and
// extensionless files) — staleness only cares "does this location exist",
// not "is this specifically a runnable command target".
const REFERENCED_PATH_RE = /\b(?:scripts|src|data|tests|memory|docs)\/[\w./-]+\b/g;

function extractReferencedPaths(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(REFERENCED_PATH_RE)) {
    const p = m[0].replace(/[.,;:)]+$/, '');
    if (p) out.add(p);
  }
  return [...out];
}

// Only fires when EVERY referenced path is missing — a card naming one dead
// script alongside three live ones is not stale, it's imprecise, and CLAUDE.md
// §15's "fix ships with its own colocated test" convention means a brand-new
// file being referenced ahead of its own creation is normal, not evidence of
// rot. Mixed live/dead paths default to REAL (ambiguous).
// A missing *.test.mjs/*.test.js is presumptively a PLANNED deliverable, not
// evidence of rot: CLAUDE.md §15 convention is that a fix ships with its own
// colocated test, so an open card naming a test file it hasn't written yet
// is normal, in-progress work — the same "new-artifact allowance"
// autonomous-triage-core.js's resolveCheckPaths already carves out for
// exactly this class. Confirmed live on this classifier's first real run
// (task #1719): both initial LIKELY-STALE hits were in-progress/paused
// cards naming their own not-yet-written test file, not deleted code.
const PLANNED_TEST_RE = /\.test\.(m|c)?js$/i;

function checkStaleFiles(card, opts) {
  const allPaths = extractReferencedPaths(card.notes);
  if (!allPaths.length || typeof opts.fileExists !== 'function') return null;
  const substantivePaths = allPaths.filter((p) => !PLANNED_TEST_RE.test(p));
  if (!substantivePaths.length) return null; // nothing but planned test files named
  const missing = substantivePaths.filter((p) => !opts.fileExists(p));
  if (missing.length && missing.length === substantivePaths.length) {
    return { type: 'stale-files', paths: missing };
  }
  return null;
}

// ── Prioritization signals (NOT evidence — never change the verdict) ────
// A live scan of the 167 Paused P1s (BRO-343, 2026-08-16) found two exact-
// string signatures covering 40% of the pool: a card parked only because a
// cmux workspace got closed without a decision, and a card whose Outcome
// records that notion-tasks-sync already saw the shared task list mark the
// underlying task completed. Both are HIGH-PRECISION indicators that a card
// is worth a human's first look — but per that scan's own instruction
// ("do NOT close on the signature alone: it means 'nobody looked', not
// 'work finished'"), a signature alone never promotes a verdict. It only
// ever sorts a REAL card toward the front of a human's review queue. Real
// confirmation is still exactly checkLikelyDone's job (acceptance command /
// commit ancestry) — spot-checked live: the auto-closed-sync sample card
// (task mirror-doubled #1478) names two real, currently-passing acceptance
// commands in its own Acceptance Criteria section, so that class of card is
// ALREADY caught by checkAcceptanceHolds once a checkout is available; the
// signal below exists for the residual cards that name no runnable command.
const WORKSPACE_CLOSED_SIGNATURE_RE = /Owner closed its workspace \(workspace:\d+\) without marking it done, so the dispatcher stopped re-opening it/i;
const TASK_MIRROR_COMPLETED_SIGNATURE_RE = /Auto-closed[^\n]*by notion-tasks-sync:[^\n]*mirrored task was marked completed in the shared task list/i;

function detectDoneSignals(card) {
  const text = `${card.notes || ''}\n${card.outcome || ''}`;
  return {
    workspaceClosedNotDecided: WORKSPACE_CLOSED_SIGNATURE_RE.test(text),
    taskMirrorReportedCompleted: TASK_MIRROR_COMPLETED_SIGNATURE_RE.test(text),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────
function classifyCard(card, allCards, opts = {}) {
  const base = {
    id: card.id,
    name: card.name,
    url: card.url || null,
    priority: card.priority || null,
    status: card.status || null,
  };

  const done = checkLikelyDone(card, opts);
  if (done) return { ...base, verdict: 'LIKELY-DONE', evidence: done, signals: detectDoneSignals(card) };

  const dup = findDuplicateForCard(card, allCards || []);
  if (dup) return { ...base, verdict: 'LIKELY-DUPLICATE', evidence: dup, signals: detectDoneSignals(card) };

  const stale = checkStaleFiles(card, opts);
  if (stale) return { ...base, verdict: 'LIKELY-STALE', evidence: stale, signals: detectDoneSignals(card) };

  return { ...base, verdict: 'REAL', evidence: null, signals: detectDoneSignals(card) };
}

function classifyPool(cards, opts = {}) {
  return (cards || []).map((card) => classifyCard(card, cards, opts));
}

module.exports = {
  detectDoneSignals,
  extractCommitShas,
  extractRecheckAfter,
  tokenizeTitle,
  titleOverlapScore,
  extractFileRefs,
  extractSymbols,
  extractReferencedPaths,
  checkAcceptanceHolds,
  checkCommitsOnMain,
  checkRecheckAfterDueAndVerified,
  checkLikelyDone,
  findDuplicateForCard,
  checkStaleFiles,
  classifyCard,
  classifyPool,
  TITLE_OVERLAP_THRESHOLD,
  TITLE_MIN_TOKENS,
};
