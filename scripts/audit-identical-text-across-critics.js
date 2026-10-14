#!/usr/bin/env node
/**
 * audit-identical-text-across-critics.js — read-only (BRO-5254 side finding).
 *
 * Finds review-text files on the same show whose fullText is identical (after
 * whitespace normalisation) but which name different critics: one article
 * stored twice, so one of the two critic attributions is wrong. Prints metadata
 * only (paths, critics, urls, flags, scores, provenance fields), never review
 * text, because CI logs are public.
 *
 * Usage:
 *   node scripts/audit-identical-text-across-critics.js            groups + count by outlet
 *   node scripts/audit-identical-text-across-critics.js --live-author [--show=a,b]
 *       also fetch each url and print the live page's author signals
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isExcludedRow } = require('./lib/variety-promo-bleed');

const USAGE = `audit-identical-text-across-critics.js — same text filed under two critics on one show (read-only).

Usage:
  node scripts/audit-identical-text-across-critics.js
  node scripts/audit-identical-text-across-critics.js --live-author [--show=id1,id2]
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const arg = (name) => {
  const a = process.argv.find(x => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  return a.includes('=') ? a.slice(name.length + 3) : '';
};
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
// Short texts (stubs, one-line excerpts) collide for dull reasons.
const MIN_CHARS = 400;
const FLAG_KEYS = ['wrongShow', 'wrongProduction', 'wrongAttribution', 'duplicateOf', 'isNonReview', 'isRoundupArticle', 'rejectionReason', 'fabricatedEntry', '_locked'];
const PROVENANCE_RE = /source|discover|added|created|method|via|origin|fetched|scraped|collected|ingest/i;
const TEXTY_RE = /text|quote|excerpt|summary|snippet|content|html|body/i;

const normCritic = (c) => String(c || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

/** Pure: groups of rows (same show, same normalised text, 2+ distinct critics). */
function identicalTextGroups(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (typeof r.d.fullText !== 'string') continue;
    const t = r.d.fullText.replace(/\s+/g, ' ').trim();
    if (t.length < MIN_CHARS) continue;
    const key = `${r.showId}:${crypto.createHash('sha1').update(t).digest('hex')}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const groups = [];
  for (const members of byKey.values()) {
    const critics = new Set(members.map(m => normCritic(m.d.criticName || m.file.split('--')[1])));
    if (members.length > 1 && critics.size > 1) groups.push(members);
  }
  return groups;
}

function loadRows(onlyShows) {
  const rows = [];
  for (const showId of listShowDirs(DIR)) {
    if (onlyShows && !onlyShows.has(showId)) continue;
    const dir = path.join(DIR, showId);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (d && typeof d === 'object' && !Array.isArray(d)) rows.push({ showId, file, rel: `${showId}/${file}`, d });
    }
  }
  return rows;
}

function describe(r) {
  const d = r.d;
  const flags = FLAG_KEYS.filter(k => d[k]).map(k => (k === 'duplicateOf' || k === 'rejectionReason' ? `${k}=${String(d[k]).slice(0, 60)}` : k));
  const prov = Object.entries(d)
    .filter(([k, v]) => PROVENANCE_RE.test(k) && !TEXTY_RE.test(k) && v != null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
  const score = typeof d.assignedScore === 'number' ? d.assignedScore : (d.llmScore && d.llmScore.score);
  return `    ${isExcludedRow(d) ? 'excluded' : 'LIVE    '} ${r.rel} critic=${JSON.stringify(d.criticName || null)} score=${score ?? '-'} url=${d.url || '-'}`
    + `${flags.length ? ` flags=[${flags.join(',')}]` : ''}${prov.length ? ` prov=[${prov.join(' ')}]` : ''}`;
}

async function main() {
  const shows = arg('show');
  const groups = identicalTextGroups(loadRows(shows ? new Set(shows.split(',')) : null));
  const byOutlet = {};
  let liveTwice = 0;
  for (const g of groups) {
    const outlet = g[0].file.split('--')[0];
    byOutlet[outlet] = (byOutlet[outlet] || 0) + 1;
    if (g.filter(m => !isExcludedRow(m.d)).length > 1) liveTwice++;
  }
  groups.sort((a, b) => a[0].rel.localeCompare(b[0].rel));
  for (const g of groups) {
    console.log(`  group ${g[0].showId} (${g.length} files, ${g[0].d.fullText.length} chars)`);
    for (const m of g) console.log(describe(m));
  }
  console.log(`identical text under 2+ critics: ${groups.length} groups, ${liveTwice} with 2+ live rows`);
  console.log('by outlet:', JSON.stringify(Object.entries(byOutlet).sort((a, b) => b[1] - a[1])));

  if (arg('live-author') === null) return 0;
  const { fetchPage } = require('./lib/scraper');
  const { extractAuthorSignals } = require('./lib/byline-evidence');
  for (const g of groups) {
    for (const url of [...new Set(g.map(m => m.d.url).filter(Boolean))]) {
      try {
        const page = await fetchPage(url);
        const sig = page && page.content ? extractAuthorSignals(page.content) : [];
        console.log(`  author ${g[0].showId} ${url}: ${sig.length ? sig.join(' | ') : 'no author signal'}${page && page.finalUrl && page.finalUrl !== url ? ` (final ${page.finalUrl})` : ''}`);
      } catch (e) {
        console.log(`  author ${g[0].showId} ${url}: fetch failed (${String(e.message || e).slice(0, 80)})`);
      }
    }
  }
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
}

module.exports = { identicalTextGroups, loadRows, MIN_CHARS };
