#!/usr/bin/env node
/**
 * Search-intent overlap analyzer (BRO-5988).
 *
 * Pulls 90 days of Search Console query+page rows for the ranked-list pages
 * (/guides/*, /best/*, /browse/*) and prints, per query, which of our URLs
 * shows up for it. Queries answered by 2+ URLs are the cannibalization set;
 * the URL with the most clicks (then impressions) is the canonical candidate
 * for src/config/search-intents.ts.
 *
 * Read-only. Run in CI (needs GOOGLE_INDEXING_KEY, which run-script.yml lacks):
 *   dispatch .github/workflows/analyze-intent-page-overlap.yml (output is in the job log)
 * Flags: --days=N (default 90), --min-imp=N (default 10), --json (machine output)
 */

const { getAccessToken, loadServiceAccount, SCOPE_WEBMASTERS, SITE_URL_GSC } = require('./submit-google-indexing');
const { describeGscError } = require('./lib/gsc-error-hint');
const { hasHelpFlag } = require('./lib/cli-help.js');

const SITE = encodeURIComponent(SITE_URL_GSC);
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.split('=')[1]);
  if (!Number.isFinite(n) || n < 0) { console.error(`Bad --${name}`); process.exit(2); }
  return n;
};
const DAYS = arg('days', 90);
const MIN_IMP = arg('min-imp', 10);
const AS_JSON = process.argv.includes('--json');
const LIST_PAGE = /^https?:\/\/[^/]+\/(guides|best|browse)\//;
let clientEmail;

async function gsc(token, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${SITE}/searchAnalytics/query`,
    {
      signal: AbortSignal.timeout(60000),
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    const hint = describeGscError(res.status, text, clientEmail);
    throw new Error(`GSC ${res.status}: ${text.slice(0, 200)}${hint ? `\n${hint}` : ''}`);
  }
  return res.json();
}

/** Strip host, query string, hash and trailing slash so one page is one key. */
function normalizePath(url) {
  const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return p || '/';
}

/** Group query+page rows by query (list pages only); the 2+ URL filter is applied in main(). */
function groupByQuery(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    const [query, page] = r.keys;
    if (!LIST_PAGE.test(page)) continue;
    const path = normalizePath(page);
    if (!byQuery.has(query)) byQuery.set(query, []);
    const list = byQuery.get(query);
    const dup = list.find(x => x.path === path);
    if (dup) { // URL variants (query string, trailing slash) of one page: merge, impression-weighted position
      const imp = dup.impressions + r.impressions;
      dup.position = imp ? (dup.position * dup.impressions + r.position * r.impressions) / imp : dup.position;
      dup.clicks += r.clicks; dup.impressions = imp;
    } else list.push({ path, clicks: r.clicks, impressions: r.impressions, position: r.position });
  }
  return byQuery;
}

async function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/analyze-intent-page-overlap.js [--days=90] [--min-imp=10] [--json]\nRead-only GSC query+page overlap report for /guides, /best, /browse (needs GOOGLE_INDEXING_KEY).');
    return;
  }
  const serviceAccount = loadServiceAccount();
  clientEmail = serviceAccount.client_email;
  const token = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS);

  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS + 1); // GSC dates are inclusive
  const fmt = d => d.toISOString().slice(0, 10);

  // Page by path prefix so the 25k row cap is spent on list pages only.
  const rows = [];
  for (const prefix of ['/guides/', '/best/', '/browse/']) {
    // Page through results (startRow) so a prefix over 25k rows is not silently truncated.
    for (let startRow = 0; ; startRow += 25000) {
      const data = await gsc(token, {
        startDate: fmt(start), endDate: fmt(end), dimensions: ['query', 'page'], rowLimit: 25000, startRow,
        dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^https?://[^/]+${prefix}` }] }],
      });
      const got = data.rows || [];
      rows.push(...got);
      if (got.length < 25000) break;
    }
  }
  if (rows.length === 0) console.error('WARNING: GSC returned 0 rows (check property access / window).');

  const byQuery = groupByQuery(rows);
  const contested = [];
  const pageTotals = new Map();
  for (const [query, pages] of byQuery) {
    for (const p of pages) {
      const t = pageTotals.get(p.path) || { clicks: 0, impressions: 0 };
      t.clicks += p.clicks; t.impressions += p.impressions;
      pageTotals.set(p.path, t);
    }
    const imp = pages.reduce((s, p) => s + p.impressions, 0);
    if (pages.length >= 2 && imp >= MIN_IMP) {
      pages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      contested.push({ query, impressions: imp, clicks: pages.reduce((s, p) => s + p.clicks, 0), pages });
    }
  }
  contested.sort((a, b) => b.impressions - a.impressions);

  if (AS_JSON) {
    console.log(JSON.stringify({ window: [fmt(start), fmt(end)], contested, pageTotals: Object.fromEntries(pageTotals) }));
    return;
  }

  console.log(`Window: ${fmt(start)} to ${fmt(end)} (${DAYS} days, ends 3 days back for GSC lag) | ${rows.length} query+page rows | ${byQuery.size} queries hit list pages`);
  console.log(`\n=== LIST PAGES BY CLICKS (/guides, /best, /browse) ===`);
  [...pageTotals.entries()].sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions)
    .slice(0, 40)
    .forEach(([p, t]) => console.log(`  ${String(t.clicks).padStart(5)} cl | ${String(t.impressions).padStart(6)} imp | ${p}`));
  console.log(`\n=== CONTESTED QUERIES (2+ of our list URLs, >=${MIN_IMP} imp): ${contested.length} ===`);
  for (const c of contested.slice(0, 60)) {
    console.log(`\n"${c.query}" (${c.impressions} imp, ${c.clicks} cl)`);
    for (const p of c.pages) {
      console.log(`    pos ${p.position.toFixed(1).padStart(5)} | ${String(p.impressions).padStart(5)} imp | ${String(p.clicks).padStart(3)} cl | ${p.path}`);
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
}

module.exports = { groupByQuery, normalizePath };
