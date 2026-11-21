#!/usr/bin/env node
/**
 * Files a dispatchable Linear card for a feedback issue that ended
 * needs-manual-review (BRO-7600). Runs as its own step in
 * auto-fix-feedback-bug.yml after the plan step, the single filer for every
 * path (plan refused, plan created, skipped, error). Fail-soft: always exits 0.
 * Env: ISSUE_NUMBER, ISSUE_BODY, PLAN_CREATED, PLAN_REFUSED ('true'|'false'|''), LINEAR_API_KEY.
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const { execFileSync } = require('child_process');
const { exitFlushed } = require('./lib/exit-flushed.js');
const { fileFeedbackCard } = require('./lib/plan-refusal-escalation.js');
const { parseDiagnosisJson } = require('./lib/feedback-submitter-store.js');

function main(env = process.env) {
  const issueNumber = env.ISSUE_NUMBER;
  if (!issueNumber) { console.log('file-feedback-card: no ISSUE_NUMBER, nothing to do'); return 0; }
  const diagnosis = parseDiagnosisJson(env.ISSUE_BODY || '') || {};
  const planState = env.PLAN_CREATED === 'true' ? 'created' : env.PLAN_REFUSED === 'true' ? 'refused' : 'none';
  const run = (args) => execFileSync('node', [path.join(__dirname, 'linear-brain.js'), ...args], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const res = fileFeedbackCard({
    diagnosis, planState, planReason: env.PLAN_REASON, issueNumber,
    issueUrl: `https://github.com/thomaspryor/Broadwayscore/issues/${issueNumber}`,
  }, { run });
  console.log(`file-feedback-card: #${issueNumber} ${res.filed ? 'filed' : res.reused ? 'card already open' : `not filed (${res.error})`}`);
  return 0;
}

if (require.main === module) exitFlushed(main());
module.exports = { main };
