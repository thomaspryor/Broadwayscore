#!/usr/bin/env node
'use strict';

/**
 * prune-stale-land-refs.js — delete stale refused land/** refs on origin (BRO-6103).
 *
 *   node scripts/prune-stale-land-refs.js            dry run (default): report candidates
 *   node scripts/prune-stale-land-refs.js --apply    delete them (at most MAX_DELETES_PER_RUN)
 *
 * Decisions + tests: scripts/lib/land-ref-prune{,.test}. Run daily by land-ref-prune.yml.
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
const { decideLandRefPrune, MAX_DELETES_PER_RUN } = require('./lib/land-ref-prune');

const USAGE = 'usage: node scripts/prune-stale-land-refs.js [--apply]';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const apply = process.argv.includes('--apply');
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const ghRaw = (args) => runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
const gh = (args) => JSON.parse(ghRaw(args));

const CARD_QUERY = 'query($id: String!) { issue(id: $id) { identifier state { type name } } }';

async function cardState(branch, cache) {
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const n = landRefCardNumber(branch);
  if (n == null) return { type: null, failed: false };
  if (cache.has(n)) return cache.get(n);
  let out;
  if (!process.env.LINEAR_API_KEY) out = { type: null, failed: true };
  else {
    try {
      const { issue } = await require('./lib/linear-client.js').graphql(CARD_QUERY, { id: `BRO-${n}` }, { timeoutMs: 15000, maxAttempts: 2 });
      out = { type: issue ? issue.state.type : null, failed: false }; // no such card: nobody wants the ref
    } catch { out = { type: null, failed: true }; }
  }
  cache.set(n, out);
  return out;
}

async function main() {
  const refs = gh([`repos/${repo}/git/matching-refs/heads/land`])
    .filter((r) => r.ref.startsWith('refs/heads/land/'))
    .map((r) => ({ branch: r.ref.replace(/^refs\/heads\//, ''), tip: r.object.sha }));
  console.log(`${refs.length} land/** ref(s) on origin; mode ${apply ? 'APPLY' : 'dry-run'}`);
  // A hand-dispatched Land run lists under main, not its ref, so while one is
  // in flight no ref's state is knowable: skip the pass (same rule as --stranded).
  const dispatched = gh([`repos/${repo}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=20`]).workflow_runs || [];
  if (dispatched.some((r) => r.status !== 'completed')) { console.log('a dispatched Land run is in flight: skipping this pass'); return; }
  const cache = new Map();
  const keptBy = {};
  const candidates = [];
  for (const { branch, tip } of refs) {
    try {
      const tipCommittedAt = gh([`repos/${repo}/commits/${tip}`]).commit.committer.date;
      let compareStatus = null;
      try { compareStatus = gh([`repos/${repo}/compare/main...${tip}?per_page=1`]).status; } catch { /* unreadable: treated as unmerged */ }
      const mergedOrOld = compareStatus === 'behind' || compareStatus === 'identical' || (Date.now() - Date.parse(tipCommittedAt)) / 86400000 >= 14;
      let runInFlight = false;
      let runIdleDays = null;
      let openPr = false;
      let card = { type: null, failed: false };
      if (mergedOrOld) {
        for (const status of ['queued', 'in_progress']) {
          const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(branch)}&status=${status}&per_page=1`]).workflow_runs || [];
          if (runs.length) runInFlight = true;
        }
        const latest = (gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(branch)}&per_page=1`]).workflow_runs || [])[0];
        if (latest) runIdleDays = (Date.now() - Date.parse(latest.updated_at)) / 86400000;
        const owner = repo.split('/')[0];
        openPr = (gh([`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`]) || []).length > 0;
        card = await cardState(branch, cache);
      }
      const d = decideLandRefPrune({ tipCommittedAt, compareStatus, runInFlight, runIdleDays, openPr, cardStateType: card.type, cardLookupFailed: card.failed });
      if (d.prune) candidates.push({ branch, tip, reason: d.reason, tipCommittedAt });
      else keptBy[d.reason] = (keptBy[d.reason] || 0) + 1;
    } catch (err) {
      keptBy['unreadable'] = (keptBy['unreadable'] || 0) + 1;
      console.log(`::warning::${branch}: skipped (${String(err.message).split('\n')[0]})`);
    }
  }
  candidates.sort((a, b) => Date.parse(a.tipCommittedAt) - Date.parse(b.tipCommittedAt)); // oldest first, so the cap never starves the tail
  const batch = candidates.slice(0, MAX_DELETES_PER_RUN);
  for (const c of candidates) console.log(`${apply && batch.includes(c) ? 'DELETE' : 'candidate'} ${c.branch} @${c.tip} (${c.reason}, tip ${c.tipCommittedAt.slice(0, 10)})`);
  let deleted = 0;
  let failed = 0;
  if (apply) {
    for (const c of batch) {
      try { ghRaw(['-X', 'DELETE', `repos/${repo}/git/refs/heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`]); deleted += 1; }
      catch (err) { failed += 1; console.log(`::warning::${c.branch}: delete refused (${String(err.message).split('\n')[0]})`); }
    }
  }
  console.log(`kept: ${JSON.stringify(keptBy)}`);
  console.log(`prune summary: ${refs.length} ref(s), ${candidates.length} candidate(s), ${deleted} deleted${apply ? '' : ' (dry-run)'}`);
  if (failed) { console.log(`::error::${failed} delete(s) refused`); process.exitCode = 1; }
}

main().catch((err) => { console.error(err); process.exit(1); });
