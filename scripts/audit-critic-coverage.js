#!/usr/bin/env node
/**
 * audit-critic-coverage.js — Compare each active T1/T2 critic's author
 * pages (Muckrack + optional BWW/NY Sun/NYSR overrides) against our
 * reviews.json and surface gaps.
 *
 * Output:
 *   data/audit/critic-coverage-audit.json          (default mode)
 *   data/audit/critic-coverage-audit-historical.json (--mode=historical)
 *
 * Run weekly via .github/workflows/audit-critic-coverage.yml.
 *
 * CLI flags:
 *   --only=<slug>       run a single critic by slug
 *   --limit=<N>         run only the first N critics
 *   --mode=historical   archive-era sweep (totalReviews>=200, no date floor,
 *                       excludes active set, capped at top 100)
 *   --dry-run           print selected critics + counts and exit (no scraping)
 */
const fs = require('fs');
const path = require('path');
const muckrack = require(path.join(__dirname, 'lib/author-pages/muckrack.js'));
const bww = require(path.join(__dirname, 'lib/author-pages/bww.js'));
const nysun = require(path.join(__dirname, 'lib/author-pages/nysun.js'));
const nysr = require(path.join(__dirname, 'lib/author-pages/nysr.js'));
const nyt = require(path.join(__dirname, 'lib/author-pages/nyt.js'));
const newyorker = require(path.join(__dirname, 'lib/author-pages/newyorker.js'));
const vulture = require(path.join(__dirname, 'lib/author-pages/vulture.js'));
const { computeCriticCoverage } = require(path.join(__dirname, 'lib/check-critic-coverage.js'));
const { buildCadenceReport } = require(path.join(__dirname, 'lib/outlet-cadence.js'));
const { updateHeartbeatState } = require(path.join(__dirname, 'lib/outlet-heartbeat-state.js'));

const REPO_ROOT = path.resolve(__dirname, '..');

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const onlyArg  = args.find(a => a.startsWith('--only='));
const modeArg  = args.find(a => a.startsWith('--mode='));
const dryRun   = args.includes('--dry-run');

const mode = modeArg ? modeArg.split('=')[1] : 'default';

// ── Data files ───────────────────────────────────────────────────────────────
// critic-registry.json lives in the private data repo; fall back to main.
function resolveDataFile(relPath) {
  const worktreePath = path.join(REPO_ROOT, relPath);
  if (fs.existsSync(worktreePath)) return worktreePath;
  const mainPath = path.join('/Users/tompryor/Broadwayscore', relPath);
  if (fs.existsSync(mainPath)) return mainPath;
  return worktreePath; // let the caller throw
}

const reg = JSON.parse(fs.readFileSync(resolveDataFile('data/critic-registry.json')));
const rev = JSON.parse(fs.readFileSync(resolveDataFile('data/reviews.json')));
const outlets = JSON.parse(fs.readFileSync(resolveDataFile('data/outlet-registry.json')));
const showsData = JSON.parse(fs.readFileSync(resolveDataFile('data/shows.json')));

// Load author-page overrides (may not exist yet — non-fatal)
let authorOverrides = {};
try {
  authorOverrides = JSON.parse(fs.readFileSync(resolveDataFile('data/critic-author-pages.json'), 'utf8'));
  // Drop meta keys (keys starting with _)
  for (const k of Object.keys(authorOverrides)) {
    if (k.startsWith('_')) delete authorOverrides[k];
  }
} catch (e) {
  console.error('[audit] No critic-author-pages.json — Muckrack only.');
}

const tierMap = {};
for (const [k,v] of Object.entries(outlets.outlets || outlets)) tierMap[k] = v.tier;

const last = {};
for (const r of rev.reviews) {
  if (!r.criticName || !r.publishDate) continue;
  if (!last[r.criticName] || r.publishDate > last[r.criticName]) last[r.criticName] = r.publishDate;
}

// ── Critic selection ──────────────────────────────────────────────────────────

// Active set: critics that default mode selects (lastDate>=2025-01-01 AND totalReviews>=20)
// This is computed regardless of mode so historical can exclude it.
const activeSet = new Set();
for (const [slug, c] of Object.entries(reg.critics)) {
  if (c.displayName === 'Unknown') continue;
  const tier = tierMap[c.primaryOutlet];
  if (tier !== 1 && tier !== 2) continue;
  const lastDate = last[c.displayName];
  if (!lastDate || lastDate < '2025-01-01') continue;
  if (c.totalReviews < 20) continue;
  activeSet.add(slug);
}

let critics = [];

if (mode === 'historical') {
  // Historical mode: totalReviews>=200, no date floor, exclude active set, cap at 100
  for (const [slug, c] of Object.entries(reg.critics)) {
    if (c.displayName === 'Unknown') continue;
    const tier = tierMap[c.primaryOutlet];
    if (tier !== 1 && tier !== 2) continue;
    if (activeSet.has(slug)) continue; // already covered by active sweep
    if (c.totalReviews < 200) continue;
    const lastDate = last[c.displayName];
    critics.push({ slug, name: c.displayName, outlet: c.primaryOutlet, tier, total: c.totalReviews, lastDate });
  }
  critics.sort((a,b) => b.total - a.total);
  critics = critics.slice(0, 100); // cap at top 100
} else {
  // Default mode: lastDate>=2025-01-01 AND totalReviews>=20
  for (const [slug, c] of Object.entries(reg.critics)) {
    if (c.displayName === 'Unknown') continue;
    const tier = tierMap[c.primaryOutlet];
    if (tier !== 1 && tier !== 2) continue;
    const lastDate = last[c.displayName];
    if (!lastDate || lastDate < '2025-01-01') continue;
    if (c.totalReviews < 20) continue;
    critics.push({ slug, name: c.displayName, outlet: c.primaryOutlet, tier, total: c.totalReviews, lastDate });
  }
  critics.sort((a,b) => b.total - a.total);
}

// Apply CLI filters (layer on top of mode selection)
if (onlyArg) {
  const slug = onlyArg.split('=')[1];
  critics = critics.filter(c => c.slug === slug);
} else if (limitArg) {
  const n = parseInt(limitArg.split('=')[1], 10);
  critics = critics.slice(0, n);
}

// ── Dry-run (print selection and exit) ───────────────────────────────────────
if (dryRun) {
  if (mode === 'historical') {
    console.log(`Selected ${critics.length} critics for historical audit (mode=historical)`);
  } else {
    console.log(`Selected ${critics.length} critics for active audit (mode=default)`);
  }
  const top5 = critics.slice(0, 5);
  for (const c of top5) {
    console.log(`- ${c.slug}  ${c.name}  totalReviews=${c.total}  lastDate=${c.lastDate || 'none'}`);
  }
  if (critics.length > 5) {
    console.log(`... and ${critics.length - 5} more`);
  }
  process.exit(0);
}

const modeLabel = mode === 'historical' ? 'historical T1/T2 critics' : 'active T1/T2 critics';
console.error(`Auditing ${critics.length} ${modeLabel} (full missing capture)`);

// ── Core ─────────────────────────────────────────────────────────────────────
const CONC = 4;
const REPORT = [];
let processed = 0;

async function processCritic(c) {
  const override = authorOverrides[c.slug] || {};

  // Build the list of source calls for this critic
  const sourceCalls = [
    { source: 'muckrack', promise: muckrack.fetch(c.slug) },
  ];
  if (override.bww)       sourceCalls.push({ source: 'bww',       promise: bww.fetch(override.bww) });
  if (override.nysun)     sourceCalls.push({ source: 'nysun',     promise: nysun.fetch(override.nysun) });
  if (override.nysr)      sourceCalls.push({ source: 'nysr',      promise: nysr.fetch(override.nysr) });
  if (override.nyt)       sourceCalls.push({ source: 'nyt',       promise: nyt.fetch(override.nyt) });
  if (override.newyorker) sourceCalls.push({ source: 'newyorker', promise: newyorker.fetch(override.newyorker) });
  if (override.vulture)   sourceCalls.push({ source: 'vulture',   promise: vulture.fetch(override.vulture) });

  const settled = await Promise.allSettled(sourceCalls.map(s => s.promise));

  const externalArts = [];
  const errors = [];
  settled.forEach((res, i) => {
    const src = sourceCalls[i].source;
    if (res.status === 'fulfilled') {
      externalArts.push(...res.value);
    } else {
      errors.push({ source: src, error: String(res.reason && res.reason.message || res.reason) });
    }
  });

  if (externalArts.length === 0 && errors.length === 0) {
    REPORT.push({ ...c, error: 'no-articles-found' });
    return;
  }

  const coverage = computeCriticCoverage(rev.reviews, c.name, externalArts);

  REPORT.push({
    ...c,
    ...coverage,
    ...(errors.length ? { errors } : {}),
  });
}

async function runBatch() {
  for (let i = 0; i < critics.length; i += CONC) {
    const batch = critics.slice(i, i + CONC);
    await Promise.all(batch.map(c => processCritic(c).then(() => {
      processed++;
      const last = REPORT[REPORT.length - 1];
      console.error(`[${processed}/${critics.length}] ${c.name} — ${last.missingCount || 0} missing`);
    })));
  }
}

// ── S4-T1/T2: outlet heartbeat ────────────────────────────────────────────────
// Per-(outlet,market) cadence, digest-first: printed + written every run, but
// only crosses into an ACTION Discord alert after 2 CONSECUTIVE red runs
// (this audit is weekly, so that's 2 consecutive weeks) — see
// outlet-heartbeat-state.js. A single red week is common noise (a market
// lull, a one-off scrape hiccup) and stays digest-only.
const HEARTBEAT_STATE_PATH = path.join(REPO_ROOT, 'data/audit/outlet-heartbeat-state.json');
const HEARTBEAT_OUT_PATH = path.join(REPO_ROOT, 'data/audit/outlet-heartbeat.json');

function marketOfCategory(cat) {
  if (cat === 'west-end' || cat === 'off-west-end') return 'west-end';
  if (cat === 'off-broadway') return 'off-broadway';
  if (cat === 'broadway') return 'broadway';
  return null;
}

async function runOutletHeartbeat() {
  const shows = showsData.shows || showsData;
  const showCat = {};
  for (const s of shows) if (s.id) showCat[s.id] = s.category;
  const marketOf = (showId) => marketOfCategory(showCat[showId]);
  const outletsMap = outlets.outlets || outlets;
  const reviews = rev.reviews || [];

  const cadenceRows = buildCadenceReport(reviews, outletsMap, { marketOf, nowMs: Date.now() });

  let prevState = {};
  try { prevState = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_PATH, 'utf8')); } catch (_) { prevState = {}; }
  const nowIso = new Date().toISOString();
  const { state, newlyActionable } = updateHeartbeatState(prevState, cadenceRows, nowIso);

  const redRows = cadenceRows.filter((r) => r.status === 'red').sort((a, b) => b.silentDays - a.silentDays);
  console.error(`\n=== Outlet heartbeat (${cadenceRows.length} outlet×market rows, ${redRows.length} red) ===`);
  for (const r of redRows.slice(0, 30)) {
    console.error(`  RED  ${r.outletId} / ${r.market}  silent ${r.silentDays}d (threshold ${r.thresholdDays}d, median gap ${r.medianGapDays}d)`);
  }
  if (redRows.length > 30) console.error(`  … ${redRows.length - 30} more red`);

  const auditDir = path.join(REPO_ROOT, 'data/audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(HEARTBEAT_OUT_PATH, JSON.stringify({ generatedAt: nowIso, rows: cadenceRows }, null, 2));
  fs.writeFileSync(HEARTBEAT_STATE_PATH, JSON.stringify(state, null, 2));
  console.error(`Wrote ${HEARTBEAT_OUT_PATH} and ${HEARTBEAT_STATE_PATH}`);

  if (newlyActionable.length) {
    console.error(`\n⚠️  ${newlyActionable.length} outlet(s) crossed 2 consecutive red weeks — sending ACTION alert.`);
    try {
      const { sendAlert } = require(path.join(__dirname, 'lib/discord-notify.js'));
      await sendAlert({
        title: 'Outlet heartbeat — 2 consecutive red weeks',
        description: `${newlyActionable.length} outlet(s) have been silent beyond their own cadence for 2 straight weekly audits.`,
        severity: 'warning',
        fields: newlyActionable.slice(0, 10).map((r) => ({
          name: `${r.outletId} / ${r.market}`,
          value: `silent ${r.silentDays}d (threshold ${r.thresholdDays}d) — investigate extractor/discovery`,
        })),
      });
    } catch (e) { console.error('Outlet heartbeat alert failed:', e.message); }
  } else {
    console.error('No outlets crossed the 2-consecutive-red-week ACTION threshold this run.');
  }
}

(async () => {
  await runBatch();
  REPORT.sort((a,b) => (b.missingCount||0) - (a.missingCount||0));
  const auditDir = path.join(REPO_ROOT, 'data/audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const outFile = mode === 'historical'
    ? 'critic-coverage-audit-historical.json'
    : 'critic-coverage-audit.json';
  const outPath = path.join(auditDir, outFile);
  fs.writeFileSync(outPath, JSON.stringify(REPORT, null, 2));
  console.error(`\nWrote ${outPath}`);
  console.error(`Total review-looking gaps: ${REPORT.reduce((s,r)=>s+(r.missingCount||0),0)}`);

  // Outlet heartbeat runs alongside the default weekly sweep only — historical
  // mode and single-critic debug runs (--only) don't touch the shared state file.
  if (mode === 'default' && !onlyArg) {
    await runOutletHeartbeat();
  }
})();
