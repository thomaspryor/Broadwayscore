'use strict';

/**
 * board-closer.js — pure decisions for BRO-7135. Two kinds of open card
 * should already be closed and nothing closes them:
 *
 *  1. "BSC Daily:" alert cards whose health row is green again. Filed by
 *     digest-autofix / owner-alert-router with a `[conditionKey:...]` line;
 *     the closer depends on a worker staying connected. We re-run the
 *     existing scripts/check-health-row-absent.js (exit 0 = row absent).
 *  2. Cards whose latest comment names a land/<name> branch that landed on
 *     main (data/audit/landings.jsonl) and is live (check-prod-deploy.js).
 *
 * No I/O here. scripts/sweep-recovered-alert-cards.js does every
 * read/spawn/write and passes plain data in (CLAUDE.md rule 15).
 */

const { healthRowNameFromConditionKey, rowAbsentCheckCmd } = require('./health-row-check-cmd.js');

const ALERT_TITLE_PREFIXES = ['BSC Daily:', 'Fix: BSC Daily:'];
const LAND_BRANCH_RE = /\bland\/[A-Za-z0-9][A-Za-z0-9._\/-]*/g;

const unescapeMd = (s) => String(s || '').replace(/\\([\[\]_*`])/g, '$1');

/** `[conditionKey:KEY]` (Linear may store it with escaped brackets) or null. */
function conditionKeyOf(description) {
  const m = unescapeMd(description).match(/\[conditionKey:([^\n]+?)\](?:\s*(?:\n|$))/);
  return m ? m[1].trim() : null;
}

function isAlertCard(issue) {
  const t = String((issue && issue.title) || '');
  return ALERT_TITLE_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Is this open card a recovered-alert candidate, and which health row does it name?
 * @returns {{kind: 'not-alert'|'terminal'|'no-condition-key'|'not-health-row'|'candidate', conditionKey?: string, row?: string}}
 */
function classifyAlertCard(issue) {
  if (!isAlertCard(issue)) return { kind: 'not-alert' };
  const type = issue.state && issue.state.type;
  if (type === 'completed' || type === 'canceled') return { kind: 'terminal' };
  const conditionKey = conditionKeyOf(issue.description);
  if (!conditionKey) return { kind: 'no-condition-key' };
  const row = healthRowNameFromConditionKey(conditionKey);
  if (!row) return { kind: 'not-health-row', conditionKey };
  return { kind: 'candidate', conditionKey, row };
}

/** check-health-row-absent.js exit code -> decision. 0 absent, 1 present, 3 cannot verify. */
function decideRecovered(exitCode) {
  if (exitCode === 0) return { action: 'close', reason: 'row-absent' };
  if (exitCode === 1) return { action: 'skip', reason: 'still-red' };
  if (exitCode === 3) return { action: 'skip', reason: 'cannot-verify' };
  return { action: 'skip', reason: 'check-error' };
}

/** Comment that closes a recovered alert card. */
function recoveredComment(row, evidenceLine) {
  return [
    `Closed by sweep-recovered-alert-cards (BRO-7135): the health row "${row}" is absent from the latest daily health snapshot.`,
    `VERIFY: ${rowAbsentCheckCmd(row)}`,
    evidenceLine ? `Evidence: ${evidenceLine}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * The land branch named by a card's LATEST comment (newest-first list of
 * {body, createdAt}). Only the latest comment counts: an older mention may
 * have been superseded by a refusal or a re-land under another name.
 * @returns {string|null}
 */
function landBranchFromComments(commentsNewestFirst) {
  const latest = (commentsNewestFirst || [])[0];
  if (!latest || !latest.body) return null;
  const found = unescapeMd(latest.body).match(LAND_BRANCH_RE);
  if (!found) return null;
  return found[found.length - 1].replace(/[.,;:)\]]+$/, '');
}

/** Newest landings.jsonl row for a branch (rows oldest-first as the ledger appends) or null. */
function landingForBranch(rows, branch) {
  let hit = null;
  for (const r of rows || []) if (r && r.branch === branch && r.sha) hit = r;
  return hit;
}

/**
 * @param {{state?: {type: string}}} issue
 * @param {{branch: string|null, landing: {sha: string}|null, liveExit: number|null}} facts
 *   liveExit = check-prod-deploy.js exit (0 live, 1 not yet, 2 unknown), null if not run
 */
function decideLanded(issue, { branch, landing, liveExit }) {
  const type = issue && issue.state && issue.state.type;
  if (type === 'completed' || type === 'canceled') return { action: 'skip', reason: 'terminal' };
  if (!branch) return { action: 'skip', reason: 'no-land-branch' };
  if (!landing) return { action: 'skip', reason: 'not-landed' };
  if (liveExit === 0) return { action: 'close', reason: 'landed-and-live', sha: landing.sha };
  if (liveExit === 1) return { action: 'skip', reason: 'landed-not-live' };
  return { action: 'skip', reason: 'live-unknown' };
}

/** Closing comment; the Done gate needs the PR-EVIDENCE shape from CLOUD.md. */
function landedComment(branch, sha) {
  return `Closed by sweep-recovered-alert-cards (BRO-7135): ${branch} landed on main and is live.\nPR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/${sha})`;
}

module.exports = {
  ALERT_TITLE_PREFIXES, conditionKeyOf, isAlertCard, classifyAlertCard, decideRecovered,
  recoveredComment, landBranchFromComments, landingForBranch, decideLanded, landedComment,
};
