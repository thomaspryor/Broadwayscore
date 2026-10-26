'use strict';

// BRO-5371: "armed for a person" is not a runnable check or an owner notification.
// This is a report-only bucket, independent of the dispatch gate's armed/refused count.
const { evaluateVerifiability } = require('./verify-gate.js');
const { sortedCommentBodies } = require('./linear-dispatch.js');
const { findOwnerDecisions } = require('./owner-decision-notify.js');
const { redactEmails } = require('./pii-scan.js');

function inScope(issue) {
  return issue && [3, 4].includes(Number(issue.priority))
    && ['backlog', 'unstarted'].includes(issue.state && issue.state.type);
}

function ownerJudgmentLimboCards(issues) {
  const pending = (issues || []).filter(inScope);
  // Share the emailer's definition: a real question in the description or the
  // awaiting-owner label. A question in a comment alone is not emailed today.
  const routed = new Set(findOwnerDecisions(pending).map(i => i.identifier));
  return pending.flatMap(issue => {
    const gate = evaluateVerifiability(issue.description || '', sortedCommentBodies(issue));
    if (!gate.ownerJudgment || gate.cmd || routed.has(issue.identifier)) return [];
    return [{
      id: issue.identifier, name: redactEmails(issue.title || ''),
      priority: issue.priority, url: issue.url || null, source: gate.source,
    }];
  });
}

async function auditOwnerJudgmentLimbo(issues, opts = {}) {
  const pending = (issues || []).filter(inScope);
  if (!pending.length) return { total: 0, checked: 0, complete: true, cards: [] };
  // Read EVERY in-scope card's comments, not just refused or enricher-labelled
  // cards. A later comment can override even a safe description command.
  const listIssueComments = opts.listIssueComments || require('./linear-client.js').listIssueComments;
  let comments;
  try {
    comments = await listIssueComments(pending.map(i => i.identifier));
  } catch {
    return { total: pending.length, checked: 0, complete: false, cards: [] };
  }
  const checked = pending.filter(i => comments.has(i.identifier));
  return {
    total: pending.length, checked: checked.length, complete: checked.length === pending.length,
    cards: ownerJudgmentLimboCards(checked.map(i => ({ ...i, comments: { nodes: comments.get(i.identifier) } }))),
  };
}

function ownerJudgmentLimboResults(report, now = Date.now()) {
  const name = 'Dispatch: owner-judgment cards without owner notification';
  const bucket = report && report.ownerJudgmentLimbo;
  const at = Date.parse(report && report.generatedAt);
  const fresh = Number.isFinite(at) && now - at <= 3 * 24 * 60 * 60 * 1000;
  const ready = bucket && bucket.complete === true && Array.isArray(bucket.cards)
    && Number.isInteger(bucket.total) && bucket.total >= 0
    && bucket.checked === bucket.total && Number(report.total) > 0 && fresh;
  const cards = bucket && Array.isArray(bucket.cards) ? bucket.cards : [];
  const hint = 'Triage data/audit/card-verifiability-linear.json ownerJudgmentLimbo.cards: add a plain-English DECISION NEEDED: question with options and a recommendation to the description if the owner must decide; otherwise post a safe-form VERIFY comment or cancel with evidence.';
  if (cards.length) {
    return [{ name, status: 'warn',
      message: `${cards.length} P2/P3 Todo/Backlog card(s) have only VERIFY: owner-judgment and no owner-notification route.${ready ? '' : ' Sweep incomplete or stale; this count may be partial.'} First: ${cards.slice(0, 3).map(c => c.id).join(', ')}`,
      hint }];
  }
  if (!ready) {
    return [{ name, status: 'warn', message: 'Owner-judgment limbo sweep incomplete, missing or stale; no clean count is available.',
      hint: 'Check the daily card-verifiability-audit.yml run and its comment reads; regenerate the Linear verifiability report.' }];
  }
  return [{ name, status: 'pass', message: `No owner-judgment-only P2/P3 card lacks an owner-notification route (${bucket.checked} checked).` }];
}

module.exports = { ownerJudgmentLimboCards, auditOwnerJudgmentLimbo, ownerJudgmentLimboResults };
