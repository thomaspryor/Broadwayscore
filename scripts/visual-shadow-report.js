#!/usr/bin/env node
/**
 * visual-shadow-report.js (BRO-7495) — the evidence for arming visual auto-ship.
 *
 *   node scripts/visual-shadow-report.js [--since=YYYY-MM-DD] [--json]
 *
 * Reads every card that ever carried a VISUAL-APPROVAL line, joins the signed CI before/after result
 * ("Visual CI result VQK") with how the owner answered (classifyStatus), and prints whether the arming
 * criteria hold: 5+ days of rows, 20+ identical rows the owner also approved, none the owner rejected.
 * Needs APPROVAL_HMAC_SECRET to verify the signed results; without it nothing is counted (exit 3).
 * Exit: 0 criteria met, 1 not met yet, 3 could not read Linear or no secret.
 */
'use strict';

const va = require('./lib/visual-approval.js');
const vci = require('./lib/visual-ci.js');
const link = require('../src/lib/owner-decision-link.js');

const QUERY = `query($teamKey: String!, $after: String, $since: DateTimeOrDuration) {
  issues(first: 50, after: $after, includeArchived: true, filter: { team: { key: { eq: $teamKey } }, description: { contains: "VISUAL-APPROVAL" }, createdAt: { gte: $since } }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier description createdAt comments(first: 100) { nodes { id body createdAt } } }
  }
}`;

/** Pure: one row per card that has a valid signed CI result for its current patch, plus the count of old asks with none. */
function buildRows(issues, secret, { now = Date.now() } = {}) {
  const rows = []; let missing = 0;
  for (const issue of issues || []) {
    const v = link.parseVisualApproval(issue.description);
    if (!v) continue;
    const nodes = (issue.comments && issue.comments.nodes) || [];
    const ci = vci.findCiResult(nodes, secret, issue.identifier, v.patch, now);
    if (!ci) {
      const askedAt = nodes.filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body || '').trim())).map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
      if (askedAt != null && now - askedAt > vci.CI_PENDING_MS) missing++;
      continue;
    }
    rows.push({ id: issue.identifier, at: ci.at, outcome: ci.outcome, owner: va.classifyStatus(issue.description, nodes) });
  }
  return { rows, missing };
}

async function fetchCards(linear, since) {
  const out = []; let after = null;
  for (let page = 0; page < 40; page++) {
    const data = await linear.graphql(QUERY, { teamKey: linear.TEAM_KEY, after, since });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error('too many cards; refusing to report on a partial list');
}

function render(a, since) {
  const lines = [
    `Visual auto-ship shadow report (since ${since})`,
    `  CI results: ${a.rows} over ${a.days} day(s); identical ${a.identical} (owner approved ${a.identicalApproved}, rejected ${a.identicalRejected}); different ${a.different}; could not capture ${a.incomplete}; not checkable ${a.blocked}; asks with no CI result ${a.missing}`,
    a.ready ? '  READY: the arming criteria hold.' : `  NOT READY: ${a.problems.join('; ')}`,
  ];
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const since = ((argv.find((x) => x.startsWith('--since=')) || '').slice(8)) || '2026-11-14';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error('Usage: node scripts/visual-shadow-report.js [--since=YYYY-MM-DD] [--json]'); return 2; }
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[shadow-report] APPROVAL_HMAC_SECRET is not set; signed CI results cannot be verified'); return 3; }
  let issues;
  try { issues = await fetchCards(require('./lib/linear-client.js'), `${since}T00:00:00Z`); } catch (e) { console.error(`[shadow-report] could not read Linear: ${e.message}`); return 3; }
  const { rows, missing } = buildRows(issues, secret);
  const a = vci.assessVisualShadow(rows, { missing });
  console.log(argv.includes('--json') ? JSON.stringify(a, null, 2) : render(a, since));
  return a.ready ? 0 : 1;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[shadow-report] ${e.stack || e.message}`); process.exitCode = 3; });
module.exports = { buildRows, render, main };
