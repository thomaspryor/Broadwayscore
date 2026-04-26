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
const { fetchPage } = require(path.join(__dirname, 'lib/scraper.js'));

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

function looksLikeReview(title, url) {
  const t = (title||'').toLowerCase();
  const u = (url||'').toLowerCase();
  const excludes = ['remembering ', 'obituary', 'in memoriam', 'best theater of', 'best plays of', 'best broadway shows', 'best of 20', 'preview ', 'what to see', '5 things', 'q&a', 'interview with', 'behind the scenes', 'what we', 'how to', 'most anticipated', 'tony nominat', 'tony predict', 'tony win', 'list:', 'shows we', 'plays we', "we can't wait", 'ate the lea', "valerie cherish"];
  if (excludes.some(e => t.includes(e))) return false;
  if (t.includes('review')) return true;
  if (t.match(/[★]/)) return true;
  if (u.includes('review')) return true;
  if (u.includes('theater-review')) return true;
  return false;
}

async function fetchMuckrack(slug, maxPages = 2) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1
      ? `https://muckrack.com/${slug}/articles`
      : `https://muckrack.com/${slug}/articles?page=${p}`;
    let html;
    try { const r = await fetchPage(url, { timeout: 30000 }); html = r && r.content; } catch { html = null; }
    if (!html || html.length < 5000) break;
    const matches = [...html.matchAll(/<h\d[^>]*>\s*<a[^>]+href="(https?:[^"]+)"[^>]*>([^<]{6,200})<\/a>/g)];
    let foundOnPage = 0;
    for (const m of matches) {
      const u = m[1];
      const title = m[2].replace(/\s+/g,' ').trim();
      if (/msn\.com|gossipbucket|flipboard|google\.com|aol\.com|yahoo\.com|inkl\.com|ourcommunitynow|thepoke/.test(u)) continue;
      all.push({ url: u, title });
      foundOnPage++;
    }
    if (foundOnPage < 10) break;
  }
  return all;
}

const CONC = 4;
const REPORT = [];
let processed = 0;

async function processCritic(c) {
  const externalArts = await fetchMuckrack(c.slug);
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
