/**
 * ci-red-dispatch-heuristic.js — decides whether a task bsc-next is about to
 * dispatch is shaped like "go fix a CI red", and if so what fingerprint
 * (symbol or GH Actions run id) to record in the ci-red-claims ledger.
 *
 * Closes the gap task #598 found: scripts/lib/ci-red-claims.js (task #584)
 * and evaluateCiRedClaim (task #542) built real enforcement — a push whose
 * diff matches an ACTIVE claim gets blocked — but nothing ever called
 * appendClaim() outside a human running `node scripts/claim-ci-red.js claim`
 * by hand. In the wild the ledger stayed empty, so the enforcement had zero
 * teeth. bsc-next.js is the one chokepoint every CI-red fix task passes
 * through (interactive cmux dispatch, --headless, --exec all call main()),
 * so it auto-claims here instead of relying on the dispatched session to
 * remember the CLI exists.
 *
 * Extraction priority (most to least specific fingerprint):
 *   1. a GH Actions run URL/id in the card text          → runId
 *   2. an <Identifier>Error crash signature               → symbol
 *   3. a "Workflow repeat-failure: <name>" BSC Daily card  → symbol
 *   4. a distinctive backtick/CONST/camelCase token        → symbol
 *   5. the task subject itself                             → symbol
 * Step 5 never produces a false conflict: evaluateCiRedClaim matches by
 * substring against OTHER tasks' subject+description, so a full-subject
 * fingerprint only collides with a near-identical title — which
 * findLiveWorkspaceForTask already treats as a duplicate dispatch, not a
 * distinct CI-red claim. Better to always record something (task #598's
 * whole point was a ledger nothing ever wrote to) than to silently skip a
 * CI-red-shaped task just because it lacks a sharper fingerprint.
 */

'use strict';

// Phrasing this repo's own CI-red cards actually use, harvested from the
// shared task list: "Fix main CI red: ..." (#563), "Test Suite red on main:
// ..." (#500, #65), "CI red on main: ..." (#484), "BSC Daily: Workflow
// repeat-failure: ..." (#417, #431, #439).
const CI_RED_PHRASE_RE = /\b(ci[\s-]?red|red on main|test suite red|main is red|workflow repeat-failure)\b/i;

const RUN_URL_RE = /actions\/runs\/(\d+)/i;
const RUN_ID_RE = /\brun\s*#?(\d{6,})\b/i;
const ERROR_SYMBOL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+((?:Reference|Type|Syntax|Range|Eval|URI)Error)\b/;
const WORKFLOW_NAME_RE = /workflow repeat-failure:\s*([^\n(—-]+)/i;
// A backtick-quoted span, a SCREAMING_SNAKE_CASE constant, or a camelCase/
// PascalCase identifier — whichever appears first is usually the one thing
// in the card that would also appear in a genuinely duplicate fix task.
const TOKEN_RE = /`([^`]+)`|\b([A-Z][A-Z0-9_]{3,})\b|\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/;

/**
 * @param {{subject?: string, description?: string}} task
 * @param {{notes?: string}|null} [card]
 * @returns {{symbol: string|null, runId: string|null}|null} null when the
 *   task doesn't look CI-red-shaped at all.
 */
function extractCiRedTarget(task, card) {
  const subject = (task && task.subject) || '';
  const body = (card && card.notes) || (task && task.description) || '';
  const text = `${subject}\n${body}`;

  // A GH Actions run URL/id is its own gate — structural evidence a task is
  // about a specific CI run even when the prose never says "CI red" (e.g.
  // "Verify Maestro E2E run 30120249897 green", #403). Everything else needs
  // the phrase gate: a bare identifier or XError elsewhere in an unrelated
  // card is too weak a signal on its own.
  const runUrl = RUN_URL_RE.exec(text);
  if (runUrl) return { runId: runUrl[1], symbol: null };

  const runId = RUN_ID_RE.exec(text);
  if (runId) return { runId: runId[1], symbol: null };

  if (!CI_RED_PHRASE_RE.test(text)) return null;

  const err = ERROR_SYMBOL_RE.exec(text);
  if (err) return { symbol: `${err[1]} ${err[2]}`, runId: null };

  const wf = WORKFLOW_NAME_RE.exec(text);
  if (wf) return { symbol: wf[1].trim(), runId: null };

  const tok = TOKEN_RE.exec(text);
  if (tok) return { symbol: (tok[1] || tok[2] || tok[3]).trim(), runId: null };

  return { symbol: subject.trim(), runId: null };
}

module.exports = { extractCiRedTarget, CI_RED_PHRASE_RE };
