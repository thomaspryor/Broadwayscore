// Comment-aware VERIFY reads for bulk-list consumers (BRO-2802).
'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { sortedCommentBodies } = require('./linear-dispatch.js');

// Fetch only the caller's shortlist. A failed read must not enable a drain
// or a landed acceptance check using a stale description command.
async function fetchIssuesWithComments(issues, opts = {}) {
  const getIssue = opts.getIssue || require('./linear-client.js').getIssue;
  const log = opts.log || (() => {});
  const fetched = [];
  for (const issue of issues) {
    try {
      const fresh = await getIssue(issue.identifier);
      if (!fresh) throw new Error('issue not found');
      fetched.push({ ...issue, ...fresh });
    } catch (err) {
      log(`[linear-verifiability] WARN could not read ${issue.identifier} with comments: ${err.message}`);
    }
  }
  return fetched;
}

// Preserve the audit's provider-independent report shape.
function evaluateLinearIssue(issue) {
  const gate = evaluateVerifiability(issue.description || '', sortedCommentBodies(issue));
  return {
    id: issue.identifier,
    name: issue.title,
    url: issue.url,
    priority: null,
    status: (issue.state && issue.state.name) || null,
    category: null,
    tags: [],
    notes: issue.description || '',
    armed: gate.armed,
    ownerJudgment: gate.ownerJudgment,
    reason: gate.reason,
    kind: gate.kind,
    cmd: gate.cmd,
  };
}

// Armed bulk rows already have proof. Only refused rows need a correction
// read to resolve this report's false refusals. Batch the board-wide audit
// rather than making one request per refused row; failed reads stay refused.
async function evaluateLinearIssues(issues, opts = {}) {
  const evaluated = issues.map(evaluateLinearIssue);
  const refused = issues.filter((_, i) => !evaluated[i].armed);
  if (!refused.length) return evaluated;
  try {
    const listIssueComments = opts.listIssueComments || require('./linear-client.js').listIssueComments;
    const comments = await listIssueComments(refused.map((issue) => issue.identifier));
    return issues.map((issue, i) => evaluated[i].armed ? evaluated[i] : evaluateLinearIssue({
      ...issue, comments: { nodes: comments.get(issue.identifier) || [] },
    }));
  } catch (err) {
    const log = opts.log || (() => {});
    log(`[linear-verifiability] WARN could not read comments for ${refused.length} refused issue(s): ${err.message}`);
    return evaluated;
  }
}

module.exports = { fetchIssuesWithComments, evaluateLinearIssue, evaluateLinearIssues };
