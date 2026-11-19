#!/usr/bin/env node
'use strict';
/**
 * File one dispatchable Linear card per parked reader-feedback issue
 * (label needs-review, no `carded` label), then label the issue `carded`.
 * Why: scripts/lib/parked-feedback.js header (feedback #1192).
 *
 * Usage: node scripts/card-parked-feedback.js [--dry-run] [--limit=N]
 * Env: GH_TOKEN/GITHUB_TOKEN (list + label issues), LINEAR_API_KEY (file cards).
 * Never exits non-zero for a filing failure: the next run retries (no label set).
 */
require('./lib/cli-help').exitOnHelp(module);
const { selectParkedIssues, buildParkedCard, CARDED_LABEL, PARKED_LABEL } = require('./lib/parked-feedback.js');

const REPO = 'thomaspryor/Broadwayscore';

async function gh(method, path, body) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': 'broadwayscore-parked-feedback', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 5; // per run; the 10-min cron drains a backlog quickly
  const issues = await gh('GET', `/repos/${REPO}/issues?state=open&labels=${PARKED_LABEL}&per_page=100`);
  const parked = selectParkedIssues(issues).sort((a, b) => a.number - b.number).slice(0, limit);
  console.log(`parked feedback issues needing a card: ${parked.length}`);
  for (const issue of parked) {
    const card = buildParkedCard(issue);
    if (dryRun) { console.log(`  would file: ${card.title}`); continue; }
    let id = null;
    try {
      const { createLinearIssue } = require('./lib/linear-issue-create.js');
      const { issue: created } = await createLinearIssue({ ...card, dispatch: true, priority: 3, source: 'parked-feedback' });
      id = created.identifier;
    } catch (e) {
      if (e && e.code === 'NEAR_DUPLICATE_OPEN' && e.twin && e.twin.identifier) id = e.twin.identifier;
      else { console.error(`::warning::#${issue.number}: could not file card: ${e.message}`); continue; }
    }
    try {
      await gh('POST', `/repos/${REPO}/issues/${issue.number}/labels`, { labels: [CARDED_LABEL] });
      await gh('POST', `/repos/${REPO}/issues/${issue.number}/comments`, { body: `Work card filed: ${id}. A worker session will do this request and close the issue when it is live.` });
      console.log(`  #${issue.number} -> ${id}`);
    } catch (e) {
      console.error(`::warning::#${issue.number}: card ${id} filed but labelling failed: ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`::warning::card-parked-feedback: ${e.message}`); });
}
module.exports = { main };
