#!/usr/bin/env node
/**
 * Daily pickup for finder-based city hubs (BRO-6854).
 *
 *   node scripts/city-finder-daily.js --city=san-diego [--days=21] [--plan=<file>]
 *
 * Runs the stage finder over the last --days days (productions open now or opened recently), then writes
 *   data/audit/city-finder-daily-<city>.json   { on, ingest, candidates }
 *   --plan (default /tmp/city-finder-ingest-<city>.json)   the ingest plan for scripts/dispatch-ingest-batch.js
 * New productions with no show yet are reported as candidates only (a show is added by a pending-fix plan).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { planPickup } = require('./lib/city-finder-daily');
const { registryId } = require('./lib/city-finder-config');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const city = arg('city', 'san-diego');
const days = Number(arg('days', 21));
const on = new Date().toISOString().slice(0, 10);
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const hubs = readJson('data/city-hubs.json').hubs;
const hubEntry = Object.entries(hubs).find(([, h]) => h.finder && h.finder.key === city);
if (!hubEntry) { console.error(`no data/city-hubs.json entry with finder.key=${city}`); process.exit(1); }
const [hubSlug] = hubEntry;

const st = spawnSync(process.execPath, [path.join(__dirname, 'city-finder-stage.js'), 'run', `--city=${city}`, `--since=${since}`], { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT });
if (st.status !== 0) { console.error('stage run failed'); process.exit(st.status || 1); }

const staged = readJson(`data/audit/city-finder-stage-${city}.json`);
const shows = readJson('data/shows.json');
const reviewsRaw = readJson('data/reviews.json');
const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || Object.values(reviewsRaw));
const dispatchedFile = path.join(ROOT, 'data', 'audit', `city-finder-dispatched-${city}.json`);
let dispatched = [];
try { dispatched = JSON.parse(fs.readFileSync(dispatchedFile, 'utf8')).urls || []; } catch { /* first run */ }
const { ingest, candidates } = planPickup({ staged, shows: Array.isArray(shows) ? shows : shows.shows, reviews, hubSlug, dispatched, outletId: registryId });

fs.writeFileSync(path.join(ROOT, 'data', 'audit', `city-finder-daily-${city}.json`), JSON.stringify({ on, since, ingest, candidates }, null, 1) + '\n');
fs.writeFileSync(arg('plan', `/tmp/city-finder-ingest-${city}.json`), JSON.stringify(ingest, null, 1));
const n = Object.values(ingest).reduce((a, v) => a + v.length, 0);
console.error(`${city}: ${n} new review URLs across ${Object.keys(ingest).length} shows, ${candidates.length} candidate productions`);
