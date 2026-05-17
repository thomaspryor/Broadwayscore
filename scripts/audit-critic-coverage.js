#!/usr/bin/env node
/**
 * audit-critic-coverage.js — Compare each active T1/T2 critic's author
 * pages (Muckrack + optional BWW/NY Sun/NYSR overrides) against our
 * reviews.json and surface gaps.
 *
 * Output: data/audit/critic-coverage-audit.json (full critic-by-critic detail).
 * Run weekly via .github/workflows/audit-critic-coverage.yml.
 *
 * CLI flags:
 *   --only=<slug>   run a single critic by slug
 *   --limit=<N>     run only the first N critics
 */
const fs = require('fs');
const path = require('path');
const muckrack = require(path.join(__dirname, 'lib/author-pages/muckrack.js'));
const bww = require(path.join(__dirname, 'lib/author-pages/bww.js'));
const nysun = require(path.join(__dirname, 'lib/author-pages/nysun.js'));
const nysr = require(path.join(__dirname, 'lib/author-pages/nysr.js'));
const { looksLikeReview } = require(path.join(__dirname, 'lib/author-pages/headline-classifier.js'));

const REPO_ROOT = path.resolve(__dirname, '..');

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const onlyArg = args.find(a => a.startsWith('--only='));

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

let critics = [];
for (const [slug, c] of Object.entries(reg.critics)) {
  if (c.displayName === 'Unknown') continue;
  const tier = tierMap[c.primaryOutlet];
  if (tier !== 1 && tier !== 2) continue;
  const lastDate = last[c.displayName];
  if (!lastDate || lastDate < '2025-01-01') continue;
  if (c.totalReviews < 20) continue;
  critics.push({ slug, name: c.displayName, outlet: c.primaryOutlet, tier, total: c.totalReviews, lastDate });
}
critics.sort((a,b)=>b.total-a.total);

// Apply CLI filters
if (onlyArg) {
  const slug = onlyArg.split('=')[1];
  critics = critics.filter(c => c.slug === slug);
} else if (limitArg) {
  const n = parseInt(limitArg.split('=')[1], 10);
  critics = critics.slice(0, n);
}

console.error(`Auditing ${critics.length} active T1/T2 critics (full missing capture)`);

// ── Helpers ──────────────────────────────────────────────────────────────────
function urlKey(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '').split('?')[0];
  } catch { return null; }
}

function ourUrlsFor(name) {
  const set = new Set();
  for (const r of rev.reviews) {
    if (r.criticName !== name) continue;
    const k = urlKey(r.url); if (k) set.add(k);
  }
  return set;
}

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
  if (override.bww)   sourceCalls.push({ source: 'bww',   promise: bww.fetch(override.bww) });
  if (override.nysun) sourceCalls.push({ source: 'nysun', promise: nysun.fetch(override.nysun) });
  if (override.nysr)  sourceCalls.push({ source: 'nysr',  promise: nysr.fetch(override.nysr) });

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

  const ours = ourUrlsFor(c.name);

  // Merge by URL key, preserving multi-source attribution
  const extMap = new Map();
  for (const a of externalArts) {
    const k = urlKey(a.url);
    if (!k) continue;
    if (extMap.has(k)) {
      const existing = extMap.get(k);
      if (!existing.sources) existing.sources = [existing.source];
      if (!existing.sources.includes(a.source)) existing.sources.push(a.source);
      // Keep the most recent date
      if (a.date && (!existing.date || a.date > existing.date)) existing.date = a.date;
    } else {
      extMap.set(k, { ...a, sources: [a.source] });
    }
  }

  const missing = [];
  for (const [k, a] of extMap) {
    if (ours.has(k)) continue;
    if (!looksLikeReview(a.title, a.url)) continue;
    missing.push(a);
  }

  REPORT.push({
    ...c,
    externalCount: extMap.size,
    ourCount: ours.size,
    missingCount: missing.length,
    missing,
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

(async () => {
  await runBatch();
  REPORT.sort((a,b) => (b.missingCount||0) - (a.missingCount||0));
  const auditDir = path.join(REPO_ROOT, 'data/audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const outPath = path.join(auditDir, 'critic-coverage-audit.json');
  fs.writeFileSync(outPath, JSON.stringify(REPORT, null, 2));
  console.error(`\nWrote ${outPath}`);
  console.error(`Total review-looking gaps: ${REPORT.reduce((s,r)=>s+(r.missingCount||0),0)}`);
})();
