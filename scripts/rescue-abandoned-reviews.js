#!/usr/bin/env node
'use strict';
/**
 * rescue-abandoned-reviews.js (BRO-7131) — retry, then escalate, real reviews that were found but whose fetch was
 * abandoned. Decisions live in scripts/lib/abandoned-review-rescue.js (read its header for the why).
 *
 *   node scripts/rescue-abandoned-reviews.js                  # report only: what it would retry or escalate
 *   node scripts/rescue-abandoned-reviews.js --apply --alert  # CI (data-health-check.yml, daily)
 *     --recent-days=45  shows opened within this many days (default 45)
 *     --max-dispatch=5  ingest-urls.yml runs per invocation (default 5)
 *     --show=ID         one show
 *
 * --apply dispatches ingest-urls.yml per show (capped-workflow-dispatch.js, caller=rescue-abandoned-reviews) and
 * records each attempt in data/audit/abandoned-review-rescue.json. --alert files one worker card per show whose rows
 * spent every retry (owner-alert-router 'auto', dispatchAtFiling): a worker fetches the page from outside GitHub with
 * make-html-handoff-plan.js. A file whose A row leaves the full sweep recovered; its ledger entry is pruned and its
 * card resolved. Ledger keys are show/file (a multi-show URL has one file per show).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/rescue-abandoned-reviews.js [--apply] [--alert] [--recent-days=45] [--max-dispatch=5] [--show=ID]';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const rescue = require('./lib/abandoned-review-rescue');
const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'data', 'audit', 'abandoned-review-rescue.json');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const APPLY = process.argv.includes('--apply');
const ALERT = process.argv.includes('--alert');
const RECENT_DAYS = Number(arg('recent-days', '45'));
const MAX_DISPATCH = Number(arg('max-dispatch', '5'));

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

function collect(now) {
  const { sweep } = require('./audit-coverage-holes');
  const out = sweep({ days: Math.max(RECENT_DAYS, 120), only: arg('show', null), now, recentDays: RECENT_DAYS });
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'), []);
  const shows = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || []).map((s) => [s.id, s]));
  const counted = new Map();
  for (const r of (readJson(path.join(ROOT, 'data', 'reviews.json'), {}).reviews || [])) {
    if (!r || !r.showId) continue;
    if (!counted.has(r.showId)) counted.set(r.showId, new Set());
    counted.get(r.showId).add(r.outletId);
  }
  const { getTier } = require('./lib/outlet-tiers');
  const rows = [];
  rows.allA = new Set(out.A.map((r) => r.file));
  rows.sweptFiles = out.files;
  for (const row of out.A) {
    const show = shows.get(row.show);
    const data = readJson(path.join(ROOT, 'data', 'review-texts', row.file), null);
    let tier = null;
    try { tier = getTier(row.outletId, { showCategory: show && show.category }); } catch { tier = null; }
    const skip = rescue.candidate({ row, data, show, tier, countedOutlets: counted.get(row.show) });
    if (!skip) rows.push({ ...row, url: data.url, title: show.title });
  }
  return rows;
}

const CAP_DEFERRED = 3; // capped-workflow-dispatch.js: the workflow's in-flight cap is full (not a failure)
function dispatch(showId, urls) {
  execFileSync('node', [path.join(__dirname, 'capped-workflow-dispatch.js'), '--workflow=ingest-urls.yml',
    '-f', `show_id=${showId}`, '-f', `urls=${urls.join('\n')}`, '-f', 'caller=rescue-abandoned-reviews'], { stdio: 'inherit' });
}

async function main() {
  const now = Date.now();
  const ledger = readJson(LEDGER, {});
  const rows = collect(now);
  const retry = new Map();
  const escalate = new Map();
  for (const r of rows) {
    const verdict = rescue.decide(ledger[r.file], now, r.bucket);
    console.log(`${verdict.padEnd(9)} ${r.file} (${r.bucket}) ${r.url}`);
    const bucket = verdict === 'retry' ? retry : (verdict === 'escalate' || verdict === 'escalated') ? escalate : null;
    if (!bucket) continue;
    if (!bucket.has(r.show)) bucket.set(r.show, []);
    bucket.get(r.show).push(r);
  }
  console.log(`\n${rows.length} rescue candidate(s): ${[...retry.values()].flat().length} to retry, ${[...escalate.values()].flat().length} spent every retry.`);

  // A file whose A row is gone from the full sweep recovered: prune it, and clear its show's card once none are
  // left. Rows that only left the candidate list (show aged out, outlet now counted) keep their entry and card.
  // Never prune on a partial view: --show, or a sweep that read no files (review-texts checkout failed).
  const resolvedShows = new Set();
  if (!arg('show', null) && rows.sweptFiles > 0) {
    for (const [file, e] of Object.entries(ledger)) {
      if (rows.allA.has(file)) continue;
      if (e.escalatedAt) resolvedShows.add(e.show);
      delete ledger[file];
    }
  }

  let dispatched = 0;
  let failed = 0;
  if (APPLY) {
    for (const [showId, list] of retry) {
      if (dispatched >= MAX_DISPATCH) { console.log(`max-dispatch ${MAX_DISPATCH} reached; the rest go next run`); break; }
      try {
        dispatch(showId, list.map((r) => r.url));
        for (const r of list) rescue.recordAttempt(ledger, r.file, { show: showId, url: r.url }, now);
        dispatched++;
      } catch (err) {
        if (err.status === CAP_DEFERRED) { console.log('ingest-urls.yml in-flight cap is full; the rest go next run'); break; }
        failed++; console.error(`[rescue] dispatch for ${showId} failed: ${err.message}`); }
    }
  }

  if (ALERT) {
    const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
    for (const showId of resolvedShows) if (!escalate.has(showId)) resolveCondition(`abandoned-review-rescue:${showId}`, { reason: 'every abandoned review recovered' });
    for (const [showId, list] of escalate) {
      try {
        await routeAlert({
          conditionKey: `abandoned-review-rescue:${showId}`,
          title: `${showId}: ${list.length} real review(s) the servers cannot fetch`,
          description: `${list.map((r) => `- ${r.file} (${r.bucket}): ${r.url}`).join('\n')}\n\n`
            + `Each URL names the show and is a review, and the ingest-urls.yml retries failed from GitHub. `
            + 'From this session (outside GitHub), for each URL: open it and confirm it is this production\'s review; then '
            + '`node scripts/make-html-handoff-plan.js --plan=bro-N --show=ID --url=URL --outlet=ID --critic="Name" --publish-date=YYYY-MM-DD`, '
            + 'land the plan and run execute-approved-fix.yml. A URL that is not this production\'s review: flag the file wrongProduction or isNonReview through the same plan.',
          severity: 'warning',
          disposition: 'auto',
          // Filed in dispatch mode (route-workflow-alerts.js's pattern): the Mac-side pass starts a worker on it, and
          // the Mac is outside GitHub, so it can fetch pages that block the runners.
          dispatchAtFiling: true,
          cooldownHours: 72,
        });
        if (APPLY) for (const r of list) { if (ledger[r.file] && !ledger[r.file].escalatedAt) ledger[r.file].escalatedAt = new Date(now).toISOString(); }
      } catch (err) { failed++; console.error(`[rescue] alert for ${showId} failed: ${err.message}`); }
    }
  }

  if (APPLY) {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Abandoned-review rescue\n${rows.length} candidate(s), ${dispatched} show(s) re-fetched, ${escalate.size} show(s) escalated to a worker\n`); } catch { /* cosmetic */ }
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(`[rescue] ${err.stack || err.message}`); process.exitCode = 1; });
