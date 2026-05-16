#!/usr/bin/env node
/**
 * audit-critic-coverage.js — Compare each active T1/T2 critic's outlet
 * Muckrack page against our reviews.json and surface gaps.
 *
 * Output: data/audit/critic-coverage-audit.json (full critic-by-critic detail).
 * Run weekly via .github/workflows/audit-critic-coverage.yml.
 */
const fs = require('fs');
const path = require('path');
const muckrack = require(path.join(__dirname, 'lib/author-pages/muckrack.js'));
const { looksLikeReview } = require(path.join(__dirname, 'lib/author-pages/headline-classifier.js'));

const REPO_ROOT = path.resolve(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/critic-registry.json')));
const rev = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/reviews.json')));
const outlets = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/outlet-registry.json')));
const tierMap = {};
for (const [k,v] of Object.entries(outlets.outlets || outlets)) tierMap[k] = v.tier;

const last = {};
for (const r of rev.reviews) {
  if (!r.criticName || !r.publishDate) continue;
  if (!last[r.criticName] || r.publishDate > last[r.criticName]) last[r.criticName] = r.publishDate;
}

const critics = [];
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
console.error(`Auditing ${critics.length} active T1/T2 critics (full missing capture)`);

function urlKey(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./,'') + x.pathname.replace(/\/$/,'').split('?')[0]; } catch { return null; }
}
function ourUrlsFor(name) {
  const set = new Set();
  for (const r of rev.reviews) {
    if (r.criticName !== name) continue;
    const k = urlKey(r.url); if (k) set.add(k);
  }
  return set;
}


const CONC = 4;
const REPORT = [];
let processed = 0;

async function processCritic(c) {
  const externalArts = await muckrack.fetch(c.slug);
  if (externalArts.length === 0) { REPORT.push({ ...c, error: 'no-articles-found' }); return; }
  const ours = ourUrlsFor(c.name);
  const extMap = new Map();
  for (const a of externalArts) {
    const k = urlKey(a.url);
    if (!k) continue;
    if (!extMap.has(k)) extMap.set(k, a);
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
    missing: missing,  // FULL list, no slice
  });
}

async function runBatch() {
  for (let i = 0; i < critics.length; i += CONC) {
    const batch = critics.slice(i, i + CONC);
    await Promise.all(batch.map(c => processCritic(c).then(() => {
      processed++;
      console.error(`[${processed}/${critics.length}] ${c.name} — ${REPORT[REPORT.length-1].missingCount||0} missing`);
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
