/**
 * card-rearm.js — pure selection/refusal logic for BRO-3395's re-arm path.
 *
 * BRO-3378's audit named 31 Linear cards whose acceptance command is ARMED
 * (evaluateVerifiability says yes) but VACUOUS (classifyVacuousCheck says the
 * command already passes on origin/main and can never distinguish finished
 * work from untouched work). enrichOneCard()'s very first line —
 * `if (gate.armed) return {action:'skipped', detail:'already armed'}` — makes
 * every one of these permanently unreachable: the enricher can only ever
 * select a card the dispatch gate currently REFUSES, never one it currently
 * (wrongly) accepts. --force does not help either — it only bypasses the
 * 'auto-enriched' tag check, never the armed gate itself.
 *
 * Two pure functions close that gap without loosening --force (which would
 * change behavior for every existing caller, including the 1000+ genuinely
 * unarmed cards --force already exists to re-process):
 *
 *   - selectRearmCandidates: which open issues are armed AND vacuous (or, if
 *     opts.identifiers is given, restricts to that explicit set — still
 *     requiring armed+vacuous, since a rearm targets exactly that failure
 *     mode, not an arbitrary card).
 *   - refuseRearmWrite: a card whose acceptance section was never touched by
 *     this enricher (no 'auto-enriched' label) is refused UNLESS the caller
 *     passes an explicit override. spliceNotes() replaces the whole
 *     "## Acceptance criteria" section wholesale — safe when the enricher
 *     wrote what's there, destructive when a human did.
 */
'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { classifyVacuousCheck, VACUOUS_TEST_F_UNRESOLVED } = require('./card-premises-auditor.js');

function isAutoEnrichedTag(tags) {
  return (tags || []).map(t => String(t).toLowerCase()).includes('auto-enriched');
}

function linearIssueNumber(identifier) {
  const m = /-(\d+)$/.exec(String(identifier || ''));
  return m ? parseInt(m[1], 10) : Infinity;
}

/**
 * Pure — given open Linear issues ({identifier, title, description, url}[],
 * the same shape linear.listOpenIssuesWithDescriptions() returns) and an
 * existence oracle (relPath) => boolean|null, returns the armed-but-vacuous
 * subset, sorted oldest-issue-first (same convention
 * selectRefusedLinearIdentifiers already uses).
 *
 * opts.identifiers, when given (array of BRO-N strings), restricts the sweep
 * to that set — the "select by identifier" path BRO-3395 asks for — but the
 * armed+vacuous requirement still applies: an identifier naming a card that
 * is NOT armed-and-vacuous is silently excluded (not a rearm case; unarmed
 * cards already flow through the ordinary enrich path, and an armed-and-not-
 * vacuous card carries no defect this exists to fix).
 *
 * @param {Array<{identifier,title,description,url}>} openIssuesWithDesc
 * @param {(relPath:string)=>boolean|null} existsFn
 * @param {{identifiers?: string[]}} [opts]
 * @returns {Array<{identifier,title,url,cmd,vacuous}>}
 */
function selectRearmCandidates(openIssuesWithDesc, existsFn, opts = {}) {
  const wanted = opts.identifiers && opts.identifiers.length
    ? new Set(opts.identifiers.map(String))
    : null;
  const out = [];
  for (const issue of (Array.isArray(openIssuesWithDesc) ? openIssuesWithDesc : [])) {
    if (!issue || !issue.identifier) continue;
    if (wanted && !wanted.has(issue.identifier)) continue;
    const gate = evaluateVerifiability(issue.description || '');
    if (!gate.armed || !gate.cmd) continue;
    const vacuous = classifyVacuousCheck(gate.cmd, existsFn);
    if (!vacuous) continue;
    // Codex adversarial-review finding (BRO-3395): an unresolved existsFn
    // probe (origin/main fetch failed or timed out this run) is NOT proof of
    // vacuousness — classifyVacuousCheck's own auditVacuousChecks caller
    // (card-premises-auditor.js) drops this kind for exactly that reason. A
    // bare truthy check here would have let a git-fetch outage select every
    // to-be-created `test -f` card as if its check were already satisfied,
    // overwriting a perfectly good acceptance command with a fresh draft on
    // nothing more than a transient network blip.
    if (vacuous.kind === VACUOUS_TEST_F_UNRESOLVED) continue;
    out.push({ identifier: issue.identifier, title: issue.title, url: issue.url || null, cmd: gate.cmd, vacuous });
  }
  return out.sort((a, b) => linearIssueNumber(a.identifier) - linearIssueNumber(b.identifier));
}

/**
 * Pure — null (proceed) when the card's own 'auto-enriched' label proves this
 * enricher wrote whatever is currently in its acceptance section, or when
 * opts.allowHumanWritten overrides the check. A refusal reason string
 * otherwise: never silently overwrite acceptance criteria a human wrote by
 * hand just because the vacuous-check sweep flagged its command.
 *
 * @param {{tags?: string[]}} card
 * @param {{allowHumanWritten?: boolean}} [opts]
 * @returns {string|null}
 */
function refuseRearmWrite(card, opts = {}) {
  if (isAutoEnrichedTag(card && card.tags)) return null;
  if (opts.allowHumanWritten) return null;
  return "card's acceptance criteria carries no 'auto-enriched' marker (looks human-written) — refusing to rewrite without --allow-human-written";
}

module.exports = { isAutoEnrichedTag, selectRearmCandidates, refuseRearmWrite, linearIssueNumber };
