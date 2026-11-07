#!/usr/bin/env node
/**
 * Daily pickup of new productions from theatreinchicago.com / theatreindc.com (BRO-6518, BRO-6771).
 *
 *   node scripts/tic-daily.js [--dry-run] [--max=15]      # stage + write data/shows.json
 *   node scripts/tic-daily.js --dispatch-ingest          # after the core-data push: ingest + score
 *   node scripts/tic-daily.js --city=dc [...]            # theatreindc.com (BRO-6771); default is chicago
 *
 * Step 1 reads /reviewlistings.php, evaluates ids not yet in shows.json with the
 * same rules as the backfill (scripts/lib/tic-stage.js), appends accepted
 * productions to data/shows.json through applyAddShow, and records what it
 * decided in data/audit/tic-daily-seen.json. Step 2 runs only once the new rows
 * are in the private repo (ingest-urls checks out core data), and dispatches one
 * ingest-urls run per new show; scoring follows automatically.
 * Wired into scrape-new-aggregators.yml (advisory, continue-on-error).
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const tic = require('./lib/theatreinchicago');
const { runDaily } = require('./lib/tic-daily');
const { getCity, assertRunnable } = require('./lib/tic-cities');
const { openingDateFor } = require('./tic-stage-shows');

const ROOT = path.join(__dirname, '..');
const SHOWS = path.join(ROOT, 'data', 'shows.json');
const PROMOTED = path.join(ROOT, 'data', 'audit', 'last-promotion-ids.json');

const flag = (n) => process.argv.includes(`--${n}`);
function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const CITY = getCity(arg('city', 'chicago'));
assertRunnable(CITY, flag('dry-run'));
const SEEN = path.join(ROOT, CITY.files.seen);
const ADDED = path.join(ROOT, CITY.files.added);
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };

async function stageAndAdd() {
  const raw = readJson(SHOWS, null);
  if (!raw) { console.log('[tic-daily] data/shows.json missing, nothing to do'); return; }
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const seen = readJson(SEEN, {});
  const today = new Date().toISOString().slice(0, 10);
  // Reset first so a failure below can never leave yesterday's list for the ingest step.
  // `pending` = shows whose ingest dispatch was deferred by the ingest-urls cap on an earlier run.
  const pending = readJson(ADDED, {}).pending || [];
  if (!flag('dry-run')) { fs.mkdirSync(path.dirname(ADDED), { recursive: true }); fs.writeFileSync(ADDED, JSON.stringify({ on: today, added: [], pending }) + '\n'); }
  const listing = tic.parseListing((await fetchPage(`${CITY.base}/reviewlistings.php`)).content);
  console.log(`[tic-daily] ${listing.length} listed`);
  const io = {
    page: async (id) => tic.parseReviewsPage((await fetchPage(tic.reviewsUrl(id, 'show', CITY.base), { skipVerify: true })).content, id, CITY.base),
    detail: async (page) => tic.parseDetailPage((await fetchPage(tic.detailUrl(page.id, page.slug, CITY.base), { skipVerify: true })).content),
    dates: (page) => openingDateFor(page),
  };
  const { added, topups = [], seen: nextSeen } = await runDaily({ listing, shows, seen, today, io, max: Number(arg('max', 15)), log: console.log, city: CITY });
  console.log(`[tic-daily] added ${added.length}, topped up ${topups.length}`);
  // Top-ups ride the ingest queue (ingest-urls skips links it already has); they are not new shows, so no image promotion.
  const queued = new Set(pending.map((p) => p.id));
  for (const t of topups) if (!queued.has(t.id)) pending.push(t);
  if (flag('dry-run')) return;
  fs.mkdirSync(path.dirname(SEEN), { recursive: true });
  // shows.json first: a crash after it only re-evaluates the ids (dedupe catches them),
  // whereas audit files written first would claim shows that never landed.
  if (added.length) fs.writeFileSync(SHOWS, JSON.stringify(raw, null, 2) + '\n');
  fs.writeFileSync(SEEN, JSON.stringify(nextSeen, null, 1) + '\n');
  fs.writeFileSync(ADDED, JSON.stringify({ on: today, added, pending }, null, 1) + '\n');
  if (!added.length) return;
  // Let the existing image-fetch step pick the new ids up.
  const prev = readJson(PROMOTED, { promoted: [] });
  prev.promoted = (prev.promoted || []).concat(added.map((a) => ({ id: a.id, source: CITY.discoverySource })));
  fs.writeFileSync(PROMOTED, JSON.stringify(prev, null, 2) + '\n');
}

// Entries are {url, critic}; plain strings are URLs left in `pending` by runs before BRO-6518.
function ingestLines(entries) {
  const { formatIngestLine } = require('./lib/ingest-url-line');
  return entries.map((e) => (typeof e === 'string' ? e : formatIngestLine({ url: e.url, critic: e.critic }))).join('\n');
}

function dispatchIngest() {
  const { dispatch } = require('./lib/rest-dispatch');
  const { checkCap } = require('./lib/workflow-queue-cap');
  const rec = readJson(ADDED, { added: [] });
  const today = new Date().toISOString().slice(0, 10);
  // Today's additions plus anything an earlier run had to defer (the ingest-urls cap, BRO-6532).
  const queue = [...(rec.pending || []), ...(rec.on === today ? rec.added : [])];
  const left = [];
  for (const a of queue) {
    if (left.length) { left.push(a); continue; }
    const cap = checkCap({ workflow: 'ingest-urls.yml' });
    if (!cap.ok) { console.log(`[tic-daily] deferred: ${cap.reason}`); left.push(a); continue; }
    try {
      dispatch({ workflow: 'ingest-urls.yml', inputs: { show_id: a.id, urls: ingestLines(a.urls), caller: 'tic-daily' } });
      console.log(`[tic-daily] ingest dispatched for ${a.id}`);
    } catch (e) {
      console.log(`::warning::ingest dispatch failed for ${a.id}: ${e.message}`);
      left.push(a);
    }
  }
  fs.writeFileSync(ADDED, JSON.stringify({ on: rec.on, added: rec.added, pending: left }, null, 1) + '\n');
  console.log(`[tic-daily] ${queue.length - left.length} dispatched, ${left.length} left for the next run`);
}

async function main() {
  if (flag('dispatch-ingest')) return dispatchIngest();
  await stageAndAdd();
  await cleanup();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
