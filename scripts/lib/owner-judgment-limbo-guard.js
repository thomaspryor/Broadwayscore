'use strict';

// BRO-5371: "armed for a person" is not a runnable check or an owner notification.
// This is a report-only bucket, independent of the dispatch gate's armed/refused count.
const { evaluateVerifiability } = require('./verify-gate.js');
const { sortedCommentBodies } = require('./linear-dispatch.js');
const { findOwnerDecisions } = require('./owner-decision-notify.js');
const { redactEmails } = require('./pii-scan.js');
const { isCardEligible, categoryOfLinearIssue } = require('./autonomous-eligibility.js');

function isHumanTerritory(issue) {
  return isCardEligible({
    name: issue.title, category: categoryOfLinearIssue(issue.description),
    tags: ((issue.labels && issue.labels.nodes) || []).map(l => l.name),
  }).kind === 'human-territory';
}

function inScope(issue) {
  return issue && ([3, 4].includes(Number(issue.priority)) || isHumanTerritory(issue))
    && ['backlog', 'unstarted'].includes(issue.state && issue.state.type);
}

function ownerJudgmentLimboCards(issues) {
  const pending = (issues || []).filter(inScope);
  // Share the emailer's definition: a real question in the description or the
  // awaiting-owner label. A question in a comment alone is not emailed today.
  const routed = new Set(findOwnerDecisions(pending).map(i => i.identifier));
  return pending.flatMap(issue => {
    const gate = evaluateVerifiability(issue.description || '', sortedCommentBodies(issue));
    const unarmedHuman = !gate.armed && gate.kind !== 'retracted' && isHumanTerritory(issue);
    if ((!gate.ownerJudgment && !unarmedHuman) || gate.cmd || routed.has(issue.identifier)) return [];
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
  // Worded for the worker card this row files (BRO-6478): headless-dispatchability.js reads "owner must decide"
  // and the literal marker as a stop sign, so neither appears here.
  const hint = 'Triage data/audit/card-verifiability-linear.json ownerJudgmentLimbo.cards, one card at a time. First check the card\'s premise against live state (run the commands, read the code, use the session\'s tools and keys; never write "no access" before trying them). If the work is doable, add a safe-form check line as a comment and do it, or cancel the card with evidence. Only when a real choice remains for the person who runs the site, put a plain-English question on its own line starting with DECISION NEEDED and a colon in the description, with the options and your recommendation (docs/owner-email-guidelines.md). That line is what emails them.';
  if (cards.length) {
    return [{ name, status: 'warn',
      message: `${cards.length} Todo/Backlog card(s) need human-territory triage or a person's judgment with no check command and no owner-notification route.${ready ? '' : ' Sweep incomplete or stale; this count may be partial.'} First: ${cards.slice(0, 3).map(c => c.id).join(', ')}`,
      hint }];
  }
  if (!ready) {
    return [{ name, status: 'warn', message: 'Owner-judgment limbo sweep incomplete, missing or stale; no clean count is available.',
      hint: 'Check the daily card-verifiability-audit.yml run and its comment reads; regenerate the Linear verifiability report.' }];
  }
  return [{ name, status: 'pass', message: `No unarmed human-territory or owner-judgment-only card lacks an owner-notification route (${bucket.checked} checked).` }];
}

// Create-time guard (BRO-5371): the audit above reports limbo cards after the fact; this refuses to mint one.
// A card is in limbo when it waits on a person but nothing tells the person: a bare marker line, or a park
// reason saying "owner review", with no DECISION NEEDED question (the only text the owner emailer reads).
// A marker LINE: the marker after optional quote, list, numbering, heading, bold or code decoration. Prose that merely
// mentions the marker mid-sentence stays allowed.
const MARKER_LINE_RE = /^[ \t]*(?:>[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)*(?:\*\*|__|`)*VERIFY:\s*owner-judgment/im;
const OWNER_REVIEW_PARK_RE = /\b(?:owner'?s?|human|manual)\s+(?:manual\s+)?(?:review|look)\b|\bawaiting\s+(?:the\s+)?owner\b|\bowner\s+(?:decision|sign-?off|approval)\b|\bowner\s+to\s+(?:review|decide|look)\b|\bfor\s+(?:the\s+)?owner(?![-\w])|\bowner(?:'?s)?\s+(?:taste|sweep)\b|\b(?:taste\s+call|deliberate\s+sweep)\b/i;

function createLimboReason({ body, parkReason } = {}) {
  const text = String(body || '');
  if (findOwnerDecisions([{ identifier: 'BRO-new', description: text }]).length) return null;
  const markerOnly = MARKER_LINE_RE.test(text) && !evaluateVerifiability(text, []).cmd;
  const reviewPark = OWNER_REVIEW_PARK_RE.test(String(parkReason || ''));
  if (!markerOnly && !reviewPark) return null;
  return `${markerOnly ? 'the notes are armed only by "VERIFY: owner-judgment"' : `the park reason "${String(parkReason).trim().slice(0, 80)}" waits on owner review`}, but no line starts with "DECISION NEEDED:", so nobody tells the owner (they do not read Linear). `
    + 'If the owner must decide, add a plain-English "DECISION NEEDED: <question>" line with the context, the options and your recommendation (docs/owner-email-guidelines.md; run node scripts/lib/owner-decision-recall.js "<topic>" first in case they already answered). '
    + 'If a worker can do it, file it with --dispatch and a safe-form VERIFY line instead.';
}

// Update path (BRO-6478): enrich-card-acceptance used to append the bare marker through an update, which the
// create-time guard never saw. Refuses an edit that leaves a card armed only by the marker; an already
// marker-only card being rewritten otherwise is not this edit's doing.
function updateLimboReason({ before, after } = {}) {
  const wasLimbo = createLimboReason({ body: before }) !== null;
  if (wasLimbo) return null;
  return createLimboReason({ body: after });
}

module.exports = { ownerJudgmentLimboCards, auditOwnerJudgmentLimbo, ownerJudgmentLimboResults, createLimboReason, updateLimboReason };
