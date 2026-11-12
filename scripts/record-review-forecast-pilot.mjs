#!/usr/bin/env node
/**
 * record-review-forecast-pilot.mjs (BRO-7329): the quiet review-forecast pilot.
 *
 * Each day: for every upcoming Broadway play/musical (in previews, or first preview within
 * 60 days) append ONE dated row to <dir>/ledger/<YYYY-MM-DD>.jsonl with the forecast (scripts/lib/review-forecast.js),
 * the preview audience grades as they stand today, and a dated pre-opening Reddit aggregate.
 * Fourteen days after opening, write <dir>/grades/<showId>.json (frozen forecast vs category
 * mean vs preview audience grade, each against getCriticScore).
 *
 * PRIVATE ONLY. This repo is public and a committed forecast is a published claim, so --dir must be
 * outside every checkout (CI passes the private core-data clone). No LLM calls.
 *
 * Usage:
 *   node scripts/record-review-forecast-pilot.mjs --dir=/tmp/core-data-checkout/review-forecast-pilot
 *        [--today=YYYY-MM-DD] [--shows=a,b] [--skip-reddit] [--dry-run] [--quiet] [--scoreboard]
 */
// venue-write-guard-ok: read-only, copies venue into in-memory feature rows; never writes shows.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCriticScore } from './lib/canonical-critic-scores.ts';

const require = createRequire(import.meta.url);
const RF = require('./lib/review-forecast.js');
const P = require('./lib/review-forecast-pilot.js');
const V2S = require('./lib/review-forecast-v2-shadow.js');
const V3 = require('./lib/review-forecast-v3-blend.js'); // BRO-7382

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const DIR = arg('dir', null);
const ONLY = arg('shows', null) ? new Set(arg('shows').split(',')) : null;
const DRY = flag('dry-run');
// A backdated --today would pair an old date with today's audience grades and score pool (leakage). Dry runs only.
if (TODAY < new Date().toISOString().slice(0, 10) && !DRY) {
  console.error('refusing a --today earlier than the real UTC date unless --dry-run is set');
  process.exit(5);
}
const FLOOR = 10;

function insideAnyCheckout(p) {
  const real = (x) => { let d = path.resolve(x); const tail = []; while (!fs.existsSync(d)) { tail.unshift(path.basename(d)); d = path.dirname(d); } return path.join(fs.realpathSync(d), ...tail); };
  const roots = new Set([fs.realpathSync(ROOT)]);
  try { const c = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(); roots.add(fs.realpathSync(path.dirname(path.resolve(ROOT, c)))); } catch { /* ROOT only */ }
  const t = real(p);
  return [...roots].some((r) => t === r || t.startsWith(r + path.sep));
}
if (!DIR) { console.error('--dir=<private ledger directory> is required'); process.exit(2); }
if (insideAnyCheckout(DIR)) { console.error('refusing: --dir must be outside every checkout of this public repo'); process.exit(3); }
// BRO-7357: nightly tripwire. The public checkout must hold no forecast rows (v1 or v2); this runs in CI every night.
{ const leaks = require('./lib/forecast-privacy-guard.js').scanTracked(ROOT); if (leaks.length) { console.error('refusing: forecast rows found in tracked public files: ' + leaks.map((l) => l.file).join(', ')); process.exit(4); } }
fs.mkdirSync(DIR, { recursive: true });
// One file per write (ledger/YYYY-MM-DD.jsonl, grades/<showId>.json): every write is a new path, so
// concurrent pushes to the private repo cannot conflict. Lines are parsed strictly, a bad line aborts.
const LEDGER_DIR = path.join(DIR, 'ledger');
const GRADES_DIR = path.join(DIR, 'grades');
const QUIET = flag('quiet'); // CI: counts only, the public Actions log must never show an unopened-show forecast
const out = (...a) => { if (!QUIET) console.log(...a); };
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readLedger = () => (fs.existsSync(LEDGER_DIR) ? fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(LEDGER_DIR, f))) : []);
const readGrades = () => (fs.existsSync(GRADES_DIR) ? fs.readdirSync(GRADES_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(GRADES_DIR, f), 'utf8'))) : []);

if (flag('scoreboard')) {
  const g = readGrades();
  console.log(JSON.stringify(P.scoreboard(g), null, 2));
  for (const r of g) console.log(`${r.showId}: critics ${r.criticScore}, forecast ${r.forecast} (miss ${r.missForecast}), category mean ${r.categoryMean} (miss ${r.missCategoryMean}), v2 ${r.forecastV2} (miss ${r.missForecastV2}), v3 ${r.forecastV3 ?? 'n/a'} (miss ${r.missForecastV3 ?? 'n/a'}, ${r.v3Origin ?? 'no earlier-run score'}), preview audience ${r.previewAudience} (miss ${r.missPreviewAudience})`);
  process.exit(0);
}

const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const shows = J('data/shows.json').shows;
const weeks = J('data/grosses-history.json').weeks;
const origins = J('data/show-origins.json').shows;
const buzz = J('data/audience-buzz.json');
const ssUrls = J('data/show-score-urls.json').shows;
const buzzOf = (id) => (buzz.shows || buzz)[id];
const slimRc = (id) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows', `${id}.json`), 'utf8')).rc ?? 0; } catch { return 0; } };

// ---- model context: same construction as backtest-review-forecast.mjs ----------------
const PERSON_CATS = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
void PERSON_CATS;
const pool = []; const byId = {};
for (const s of shows) {
  if (!s.openingDate || RF.toDay(s.openingDate) == null) continue;
  const score = getCriticScore(s.id);
  if (score == null) continue;
  const rc = slimRc(s.id);
  const rec = { id: s.id, title: s.title, openingDate: s.openingDate, score, rc, category: s.category, type: s.type, isRevival: !!s.isRevival, venue: s.venue || null, people: RF.peopleOf(s.creativeTeam), status: s.status };
  byId[s.id] = rec;
  if (rc >= 3) pool.push(rec);
}
const ctx = { pool, weeks, origins };
// BRO-7382: v3 inputs. Own-record earlier-run reviews (same builder as the backtest) and the web-collected compact file; weight rows are historical walk-forward predictions.
const jsonOr = (f, d) => { try { return J(f); } catch (e) { console.error(`WARN: ${f} unreadable (${e.message}), v3 runs without it tonight`); return d; } };
const allReviews = jsonOr('data/reviews.json', { reviews: [] }).reviews;
const reviewsByShow = V3.buildReviewsByShow(allReviews, byId);
if (!reviewsByShow.size) console.error('WARN: data/reviews.json missing or empty, v3 has no own-record earlier-run scores tonight');
const ctx3 = { pool, reviewsByShow, earlierRun: jsonOr(V3.EARLIER_RUN_FILE, { reviews: {} }).reviews, origins };
const v3WeightRows = jsonOr(V3.WEIGHT_ROWS_FILE, { rows: [] }).rows;
if (!v3WeightRows.length) console.error('WARN: v3 weight rows empty, v3 is passthrough tonight');
const targetOf = (s) => ({ id: s.id, title: s.title, openingDate: s.openingDate, category: s.category, type: s.type, isRevival: !!s.isRevival, venue: s.venue || null, people: RF.peopleOf(s.creativeTeam) });

// Training rows: opened Broadway shows with a settled score, same rules as the backtest.
const SETTLE_DAYS = 21; const MIN_PRIOR_SHOWS = 30;
const trainRows = [];
for (const s of shows) {
  const t = byId[s.id];
  if (!t || s.category !== 'broadway' || t.rc < FLOOR || (s.type !== 'play' && s.type !== 'musical') || s.noReviewsExpected || s.cancelledBeforeOpening) continue;
  if (!(RF.toDay(s.openingDate) <= RF.toDay(TODAY) - SETTLE_DAYS)) continue;
  const f = RF.buildFeatures(t, ctx, { floor: FLOOR });
  RF.assertNoLeakage(t, f.provenance);
  if (f.mu == null || f.baselineN < MIN_PRIOR_SHOWS) continue;
  trainRows.push({ season: RF.seasonStartYear(t.openingDate), x: f.x, mu: f.mu, y: t.score });
}
const forecaster = P.fitForecaster(trainRows);
if (!forecaster) { console.error(`refusing: only ${trainRows.length} training rows (<150)`); process.exit(4); }
console.error(`model fit on ${forecaster.n} opened shows`);

// ---- Reddit (read-only reuse of the scraper's fetch + post filters) -------------------
let redditDeps = null;
async function loadReddit() {
  if (redditDeps) return redditDeps;
  const { searchAllPosts } = require('./lib/reddit-api.js');
  const { buildAudienceSearchQueries } = require('./lib/reddit-post-filters.js');
  const { computeProductionWindow, isPostInProductionWindow } = require('./lib/production-window.js');
  const { classifyPost } = require('./lib/reddit-post-filters.js');
  redditDeps = { searchAllPosts, buildAudienceSearchQueries, computeProductionWindow, isPostInProductionWindow, classifyPost };
  return redditDeps;
}
async function redditFor(show) {
  // BRO-7337: Reddit is retired (config/retired-sources.json). No queries, no spend.
  const { createRequire } = await import('node:module');
  if (createRequire(import.meta.url)('./lib/reddit-status.js').isRedditRetired()) return { available: false, reason: 'reddit retired' };
  const d = await loadReddit();
  const win = d.computeProductionWindow(show, shows);
  // The scraper floors at first preview; the pilot wants the lead-up too. Only safe without an earlier sibling production.
  const window = { ...win, floorSec: win.hasSiblings ? win.floorSec : null };
  const queries = d.buildAudienceSearchQueries({ cleanTitle: show.title.replace(/[()]/g, '').trim(), marketName: 'Broadway', isWestEnd: false, isOpera: false });
  const posts = []; const seen = new Set(); let failed = 0;
  for (const q of queries) {
    try {
      for (const p of await d.searchAllPosts('broadway', q, 300, { allowRss: true })) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (d.classifyPost(p, show.title) === false) continue; // industry, film, roundup
        if (!d.isPostInProductionWindow(p, show, window)) continue;
        posts.push(p);
      }
    } catch { failed += 1; }
  }
  if (failed === queries.length) return { available: false, reason: 'all reddit queries failed' };
  const viaRss = posts.filter((p) => p._viaRss).length;
  const agg = P.redditAggregate(posts, { previewsStartDate: show.previewsStartDate || show.previewDate, today: TODAY });
  return { ...agg, queriesRun: queries.length, queriesFailed: failed, postsViaRss: viaRss, siblingProduction: win.hasSiblings };
}

// ---- record ----------------------------------------------------------------------------
const existing = readLedger();
const done = new Set(existing.filter((r) => r.recordedAt === TODAY).map((r) => r.showId));
const candidates = [];
for (const s of shows) {
  if (ONLY && !ONLY.has(s.id)) continue;
  if (!P.isPilotTarget(s, TODAY) || done.has(s.id)) continue;
  const t = targetOf(s);
  const f = RF.buildFeatures(t, ctx, { floor: FLOOR });
  RF.assertNoLeakage(t, f.provenance);
  if (f.mu == null) { console.error(`skip ${s.id}: no baseline`); continue; }
  const p = forecaster.predict(f);
  let reddit = { available: false, reason: 'skipped' };
  if (!flag('skip-reddit')) {
    try { reddit = await redditFor(s); } catch (e) { reddit = { available: false, reason: `error: ${String(e.message).slice(0, 120)}` }; }
  }
  const v1Part = { forecast: Math.round(p.forecast), forecastRaw: Math.round(p.forecast * 10) / 10, lo80: Math.round(p.lo80), hi80: Math.round(p.hi80) };
  // BRO-7357: v2 shadow beside v1, new field only. Uses the Show Score score+count already in audience-buzz; never fetched here.
  const v2 = V2S.buildV2Shadow({ features: f, v1: v1Part, showScore: V2S.showScoreInput(buzzOf(s.id)), openingDate: s.openingDate, recordedAt: TODAY, pageUrl: ssUrls[s.id] || null });
  // BRO-7382: v3 shadow, new field only. Earlier-run score dated by min(day before first preview, opening minus 3 days); no score means v3 = v2.
  const t3 = { id: s.id, title: s.title, openingDate: s.openingDate, previewsStartDate: s.previewsStartDate || null };
  const earlier = V3.earlierRunScore(t3, ctx3, f.mu);
  let leak = null;
  if (earlier) { try { V3.assertNoLeakageV3(t3, earlier); } catch (e) { leak = e.message; console.error('WARN: ' + leak); } } // a v3 problem must never drop the v1/v2 rows
  const v3 = V3.buildV3Shadow({ v2, earlier: leak ? null : earlier, weightRows: v3WeightRows, openingDate: s.openingDate, recordedAt: TODAY });
  candidates.push({
    showId: s.id, recordedAt: TODAY, openingDate: s.openingDate, previewsStartDate: s.previewsStartDate || null, status: s.status,
    ...v1Part, categoryMean: Math.round(f.mu * 10) / 10,
    inputs: { priorRun: f.priorScore != null, previewGrosses: f.hasGross, peopleWithHistory: ['dir', 'chor', 'writer'].filter((k) => f.x[k] !== 0), trainN: forecaster.n },
    audience: P.audienceSnapshot(buzzOf(s.id)),
    reddit,
    v2,
    v3,
  });
}
const { append, skipped } = P.selectAppendable(existing, candidates);
for (const k of skipped) console.error(`not recorded ${k.row.showId}: ${k.why}`);
console.error(`${DRY ? 'DRY RUN, would append' : 'appending'} ${append.length} ledger rows for ${TODAY}`);
if (!DRY && append.length) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const f = path.join(LEDGER_DIR, `${TODAY}.jsonl`);
  const prior = fs.existsSync(f) ? readJsonl(f) : [];
  fs.writeFileSync(f, prior.concat(append).map((r) => JSON.stringify(r)).join('\n') + '\n');
}
for (const r of append) out(`${r.showId} opens ${r.openingDate}: forecast ${r.forecast} [${r.lo80}-${r.hi80}] v2 ${r.v2.forecast} [${r.v2.lo80}-${r.v2.hi80}] (${r.v2.inputsPresent.join('+')}) v3 ${r.v3.v3Forecast} ${r.v3.v3Applied ? `(${r.v3.v3Origin}, ${r.v3.v3EarlierN} reviews, w ${r.v3.v3Weight})` : '(no earlier-run score)'} mean ${r.categoryMean} audience ${r.audience.combined} reddit ${r.reddit.available ? `${r.reddit.leadup.postCount}+${r.reddit.previews.postCount} posts` : r.reddit.reason}`);

// ---- grade ------------------------------------------------------------------------------
const ledgerAll = existing.concat(DRY ? [] : append);
const graded = new Set(readGrades().map((g) => g.showId));
const newGrades = [];
for (const s of shows) {
  if (graded.has(s.id) || !P.isGradeDue(s.openingDate, TODAY)) continue;
  const frozen = P.frozenForecastRow(ledgerAll, s.id, s.openingDate);
  if (!frozen) continue;
  // Same settle floor as the backtest: wait until the critic score rests on >= FLOOR reviews.
  const rcAtGrade = slimRc(s.id);
  if (rcAtGrade < FLOOR) continue;
  const g = P.buildGradeRow({ showId: s.id, openingDate: s.openingDate, today: TODAY, frozen, criticScore: getCriticScore(s.id), frozenV2: V2S.frozenV2Row(ledgerAll, s.id, s.openingDate), frozenV3: V3.frozenV3Row(ledgerAll, s.id, s.openingDate) });
  if (g) g.rcAtGrade = rcAtGrade;
  if (g) newGrades.push(g);
}
console.error(`${DRY ? 'DRY RUN, would append' : 'appending'} ${newGrades.length} grade rows`);
if (!DRY && newGrades.length) {
  fs.mkdirSync(GRADES_DIR, { recursive: true });
  for (const g of newGrades) fs.writeFileSync(path.join(GRADES_DIR, `${g.showId}.json`), JSON.stringify(g, null, 2) + '\n');
}
for (const g of newGrades) out(`graded ${g.showId}: critics ${g.criticScore}, forecast ${g.forecast}, miss ${g.missForecast}`);
