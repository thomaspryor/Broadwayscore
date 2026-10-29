#!/usr/bin/env node
/**
 * Daily pickup of new Chicago productions from theatreinchicago.com (BRO-6518).
 *
 *   node scripts/tic-daily.js [--dry-run] [--max=15]      # stage + write data/shows.json
 *   node scripts/tic-daily.js --dispatch-ingest          # after the core-data push: ingest + score
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
const { openingDateFor } = require('./tic-stage-shows');

const ROOT = path.join(__dirname, '..');
const SHOWS = path.join(ROOT, 'data', 'shows.json');
const SEEN = path.join(ROOT, 'data', 'audit', 'tic-daily-seen.json');
const ADDED = path.join(ROOT, 'data', 'audit', 'tic-daily-added.json');
const PROMOTED = path.join(ROOT, 'data', 'audit', 'last-promotion-ids.json');

const flag = (n) => process.argv.includes(`--${n}`);
function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };

async function stageAndAdd() {
  const raw = readJson(SHOWS, null);
  if (!raw) { console.log('[tic-daily] data/shows.json missing, nothing to do'); return; }
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const seen = readJson(SEEN, {});
  const today = new Date().toISOString().slice(0, 10);
  // Reset first so a failure below can never leave yesterday's list for the ingest step.
  if (!flag('dry-run')) { fs.mkdirSync(path.dirname(ADDED), { recursive: true }); fs.writeFileSync(ADDED, JSON.stringify({ on: today, added: [] }) + '\n'); }
  const listing = tic.parseListing((await fetchPage(`${tic.BASE}/reviewlistings.php`)).content);
  console.log(`[tic-daily] ${listing.length} listed`);
  const io = {
    page: async (id) => tic.parseReviewsPage((await fetchPage(tic.reviewsUrl(id), { skipVerify: true })).content, id),
    detail: async (page) => tic.parseDetailPage((await fetchPage(tic.detailUrl(page.id, page.slug), { skipVerify: true })).content),
    dates: (page) => openingDateFor(page),
  };
  const { added, seen: nextSeen } = await runDaily({ listing, shows, seen, today, io, max: Number(arg('max', 15)), log: console.log });
  console.log(`[tic-daily] added ${added.length}`);
  if (flag('dry-run')) return;
  fs.mkdirSync(path.dirname(SEEN), { recursive: true });
  fs.writeFileSync(SEEN, JSON.stringify(nextSeen, null, 1) + '\n');
  fs.writeFileSync(ADDED, JSON.stringify({ on: today, added }, null, 1) + '\n');
  if (!added.length) return;
  fs.writeFileSync(SHOWS, JSON.stringify(raw, null, 2) + '\n');
  // Let the existing image-fetch step pick the new ids up.
  const prev = readJson(PROMOTED, { promoted: [] });
  prev.promoted = (prev.promoted || []).concat(added.map((a) => ({ id: a.id, source: 'theatreinchicago' })));
  fs.writeFileSync(PROMOTED, JSON.stringify(prev, null, 2) + '\n');
}

function dispatchIngest() {
  const { dispatch } = require('./lib/rest-dispatch');
  const rec = readJson(ADDED, { added: [] });
  if (rec.on !== new Date().toISOString().slice(0, 10)) { console.log('[tic-daily] no run today, nothing to ingest'); return; }
  for (const a of rec.added) {
    try {
      dispatch({ workflow: 'ingest-urls.yml', inputs: { show_id: a.id, urls: a.urls.join('\n') } });
      console.log(`[tic-daily] ingest dispatched for ${a.id}`);
    } catch (e) {
      console.log(`::warning::ingest dispatch failed for ${a.id}: ${e.message}`);
    }
  }
}

async function main() {
  if (flag('dispatch-ingest')) return dispatchIngest();
  await stageAndAdd();
  await cleanup();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
