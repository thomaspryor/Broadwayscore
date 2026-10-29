#!/usr/bin/env node
/**
 * dispatch-ingest-batch.js — ingest a vetted plan of review URLs without flooding Actions (BRO-6485).
 *
 * A plan is JSON: { "<showId>": [{ "url": "...", "outlet": "<outlet id>" }, ...] }.
 * 1. Validates every entry (url, outlet id in data/outlet-registry.json) before dispatching anything.
 * 2. Dispatches ingest-urls.yml once per show with no_rebuild=true, waiting while the repo's
 *    queued+pending run count is at --max-active. Each dispatched show is appended to the
 *    checkpoint file, so a rerun resumes.
 * 3. Waits for every ingest-urls run to finish, then dispatches ONE llm-ensemble-score run with
 *    the comma-separated show list and ONE rebuild-reviews run (instead of one each per show).
 *
 * CLI: node scripts/dispatch-ingest-batch.js --plan=<file> [--checkpoint=<file>] [--max-active=15]
 *        [--spacing=12] [--max-wait-min=120] [--limit=N] [--dry-run] [--finish-only]
 * Exit 2 when a wait passes --max-wait-min (progress stays in the checkpoint; rerun to continue).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dispatchWorkflow, fetchGitHubJSON } = require('./lib/gh-api-client');
const { DEFAULT_MAX_ACTIVE, pendingShows, emptyShows, formatUrlsInput, queueHasRoom } = require('./lib/ingest-batch-pacing');

const REPO = 'thomaspryor/Broadwayscore';
const CALLER = 'dispatch-ingest-batch';
const API = `https://api.github.com/repos/${REPO}/actions`;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WaitTimeout extends Error {}

/** Sum of total_count over the statuses; NaN on an API error (the caller waits and retries). */
async function countRuns(statuses, workflowFile) {
  const base = workflowFile ? `${API}/workflows/${workflowFile}/runs` : `${API}/runs`;
  let total = 0;
  try {
    for (const s of statuses) {
      const body = await fetchGitHubJSON(`${base}?status=${s}&per_page=1`, { caller: CALLER });
      total += Number(body && body.total_count);
    }
    return total;
  } catch (err) {
    console.error(`run count failed: ${err.message}`);
    return NaN;
  }
}

async function waitUntil(label, check, deadline) {
  for (;;) {
    const { ok, n } = await check();
    if (ok) return;
    if (Date.now() > deadline) throw new WaitTimeout(`gave up waiting for ${label} (last count ${n})`);
    console.log(`${label}: ${n}, waiting 60s`);
    await sleep(60000);
  }
}

function knownOutletIds() {
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
  return new Set([...Object.keys(reg.outlets || {}), ...Object.keys(reg._aliasIndex || {})]);
}

async function dispatchOrThrow(workflow, inputs) {
  const res = await dispatchWorkflow({ workflow, inputs, caller: CALLER, repo: REPO });
  if (!res.ok) throw new Error(`dispatch ${workflow} failed: ${res.error}`);
}

async function main() {
  const planFile = arg('plan');
  if (!planFile) throw new Error('--plan=<file> is required');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const checkpoint = arg('checkpoint', `${planFile}.dispatched`);
  const maxActive = Number(arg('max-active', DEFAULT_MAX_ACTIVE));
  const spacingMs = Number(arg('spacing', 12)) * 1000;
  const maxWaitMs = Number(arg('max-wait-min', 120)) * 60000;
  const limit = Number(arg('limit', Infinity));
  const dryRun = process.argv.includes('--dry-run');
  const finishOnly = process.argv.includes('--finish-only');

  if (!dryRun && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('GH_TOKEN or GITHUB_TOKEN must be set');

  const known = knownOutletIds();
  const done = fs.existsSync(checkpoint) ? fs.readFileSync(checkpoint, 'utf8').split('\n').filter(Boolean) : [];
  const todo = finishOnly ? [] : pendingShows(plan, done).slice(0, limit);
  // Validate every entry before the first dispatch, so a bad row cannot stop a batch halfway.
  const inputs = todo.map((id) => ({ id, urls: formatUrlsInput(plan[id], known) }));
  const empties = emptyShows(plan);
  if (empties.length) console.log(`skipping ${empties.length} show(s) with no entries: ${empties.join(', ')}`);
  console.log(`${inputs.length} shows to ingest (${done.length} already in ${checkpoint}); active-run cap ${maxActive}`);
  if (dryRun) {
    for (const { id, urls } of inputs) console.log(`[dry-run] ${id}: ${urls.split('\n').length} url(s)`);
    return;
  }

  // One process per checkpoint: two copies would dispatch the same shows twice.
  const lock = `${checkpoint}.lock`;
  const fd = fs.openSync(lock, 'wx');
  try {
    let sent = 0;
    for (const { id, urls } of inputs) {
      await waitUntil('queued+pending runs', async () => {
        const n = await countRuns(['queued', 'pending']);
        return { ok: queueHasRoom(n, maxActive), n };
      }, Date.now() + maxWaitMs);
      await dispatchOrThrow('ingest-urls.yml', { show_id: id, urls, no_rebuild: 'true' });
      fs.appendFileSync(checkpoint, `${id}\n`);
      console.log(`ingest dispatched ${id} (${++sent}/${inputs.length})`);
      await sleep(spacingMs);
    }

    const shows = fs.existsSync(checkpoint) ? [...new Set(fs.readFileSync(checkpoint, 'utf8').split('\n').filter(Boolean))] : [];
    if (!shows.length) return;
    await waitUntil('ingest-urls runs still active', async () => {
      const n = await countRuns(['queued', 'pending', 'in_progress'], 'ingest-urls.yml');
      return { ok: n === 0, n };
    }, Date.now() + maxWaitMs);
    // A comma-separated show_id runs in llm-ensemble-score's single "shows-multi" lane.
    await dispatchOrThrow('llm-ensemble-score.yml', { show_id: shows.join(',') });
    await dispatchOrThrow('rebuild-reviews.yml', { reason: `dispatch-ingest-batch: ${shows.length} shows from ${path.basename(planFile)}` });
    console.log(`scoring and rebuild dispatched for ${shows.length} shows`);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err instanceof WaitTimeout ? 2 : 1);
});
