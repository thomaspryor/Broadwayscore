#!/usr/bin/env node
/**
 * Advisory: compares the URL count of the freshly built sitemap shards against
 * the live site's (BRO-5969). Warns (never fails) on a drop over 3%.
 * Usage: node scripts/check-sitemap-count-delta.js [builtSitemapDir]
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { fetchSitemapIndexUrls } = require('./lib/sitemap-urls');
const { sitemapCountDelta, countLocs } = require('./lib/sitemap-count-delta');

async function main() {
  const dir = process.argv[2] || '.vercel/output/static/sitemap';
  if (!fs.existsSync(dir)) { console.log(`::warning::sitemap delta guard did nothing: no built sitemap dir at ${dir}`); return; }
  let local = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.xml'))) local += countLocs(fs.readFileSync(path.join(dir, f), 'utf8'));
  const urls = await fetchSitemapIndexUrls();
  if (!urls.length) { console.log('live sitemap list unavailable; skipping'); return; }
  let live = 0;
  for (const u of urls) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (r.ok) live += countLocs(await r.text()); } catch {}
  }
  const { ok, drop } = sitemapCountDelta(live, local);
  console.log(`sitemap URLs: live ${live}, built ${local} (${(drop * 100).toFixed(1)}% drop)`);
  if (!ok) console.log(`::warning::Built sitemap has ${(drop * 100).toFixed(1)}% fewer URLs than live (${local} vs ${live}). Check for an accidental noindex or filter.`);
}
main().catch(e => console.log(`sitemap delta check skipped: ${e.message}`));
