#!/usr/bin/env node
/**
 * Reverse discovery audit — alert-only detector for shows the aggregators
 * are reviewing that are NOT in shows.json.
 *
 * Sources (v1):
 *   - WE/OWE: WestEndTheatre.com WP-API, category 10 (review roundups).
 *     WET publishes a roundup for every notable WE/OWE opening — a roundup
 *     whose show title matches nothing in shows.json is a missing show.
 *   - BW/OB:  DTLI shows-sitemap entries (last 2 sitemaps) with a recent
 *     lastmod. DTLI creates/updates a show page around opening night.
 *
 * NEVER writes shows.json. Writes data/audit/reverse-discovery-candidates.json
 * (full current view) + data/audit/reverse-discovery-state.json (per-candidate
 * firstSeen/alerted, so each candidate alerts once). New candidates fire a
 * Discord warning listing the add-show command.
 *
 * Pattern: detect-ob-closings.js (alert-only detector, digest-friendly).
 * Origin: Midnight at the Never Get miss (Notion card 3a4637c5…, task #101).
 */

const USAGE = `audit-reverse-discovery.js — find reviewed-but-missing shows

Usage:
  node scripts/audit-reverse-discovery.js [--dry-run] [--days=N] [--source=wet|dtli|all]

Options:
  --dry-run     Print candidates; skip state/audit writes and Discord alert
  --days=N      Recency window for source items (default 45)
  --source=X    Limit to one source (default all)
  --help, -h    Show this help

Exit codes: 0 = ran (candidates or not); 1 = every source fetch failed.
Caveat: a same-title revival of a catalogued show will NOT surface (title
matches the older entry) — the WE completeness gate covers those once added.`;

function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }

  // Requires after the --help gate so help never touches network/env (#260 class).
  const fs = require('fs');
  const path = require('path');
  const { fetchPage, fetchJSON } = require('./lib/scraper');
  const {
    extractShowTitleFromWetRoundup, titleFromDtliSlug,
    buildShowTitleIndex, findUnmatchedCandidates, candidateKey,
  } = require('./lib/reverse-discovery');

  const dryRun = argv.includes('--dry-run');
  const days = parseInt((argv.find(a => a.startsWith('--days=')) || '').split('=')[1] || '45', 10);
  const sourceFilter = (argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || 'all';
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
  // Market-scoped: shows.json keeps separate entries per market, so a WET
  // roundup for a title catalogued only on Broadway means the WE production
  // IS missing — a global index would swallow it.
  const weIndex = buildShowTitleIndex(shows, 'we');
  const nycIndex = buildShowTitleIndex(shows, 'nyc');
  console.log(`Loaded ${shows.length} shows (${weIndex.exact.size} WE / ${nycIndex.exact.size} NYC title variants)`);

  const items = [];
  let sourcesOk = 0, sourcesTried = 0;

  // ── Source 1: WET roundups (WE/OWE) ──
  if (sourceFilter === 'all' || sourceFilter === 'wet') {
    sourcesTried++;
    try {
      const posts = await fetchJSON(
        'https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=30&_fields=id,title,link,date'
      );
      if (!Array.isArray(posts)) throw new Error('WET API returned non-array');
      let parsed = 0;
      for (const p of posts) {
        const ts = Date.parse(p.date);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const title = extractShowTitleFromWetRoundup(p.title && p.title.rendered);
        if (!title) continue;
        parsed++;
        items.push({ title, source: 'wet-roundup', url: p.link, date: p.date, market: 'west-end' });
      }
      // 0 parsed from a non-empty recent feed = title-format drift → treat as
      // source failure so the detector can't rot silently.
      const recentPosts = posts.filter(p => Date.parse(p.date) >= cutoff).length;
      if (recentPosts > 0 && parsed === 0) throw new Error(`WET title-format drift: ${recentPosts} recent posts, 0 parsed`);
      console.log(`WET: ${parsed} roundups within ${days}d`);
      sourcesOk++;
    } catch (e) {
      console.error(`WET source failed: ${e.message}`);
    }
  }

  // ── Source 2: DTLI show sitemaps (BW/OB) ──
  if (sourceFilter === 'all' || sourceFilter === 'dtli') {
    sourcesTried++;
    try {
      const idx = (await fetchPage('https://didtheylikeit.com/sitemap_index.xml')).content;
      const maps = [...idx.matchAll(/<loc>(https:\/\/didtheylikeit\.com\/shows-sitemap(\d+)\.xml)<\/loc>/g)]
        .sort((a, b) => Number(a[2]) - Number(b[2]))
        .map(m => m[1]);
      if (maps.length === 0) throw new Error('DTLI sitemap index had no shows-sitemaps');
      let found = 0, noLastmod = 0, totalEntries = 0;
      for (const url of maps.slice(-2)) {
        const xml = (await fetchPage(url)).content;
        const entries = [...xml.matchAll(
          /<url>\s*<loc>https:\/\/didtheylikeit\.com\/shows\/([^/<]+)\/<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g
        )];
        totalEntries += entries.length;
        for (const [, slug, lastmod] of entries) {
          const ts = lastmod ? Date.parse(lastmod) : NaN;
          if (!lastmod) { noLastmod++; continue; }
          if (!Number.isFinite(ts) || ts < cutoff) continue;
          const title = titleFromDtliSlug(slug);
          if (!title) continue;
          found++;
          items.push({
            title, source: 'dtli-sitemap',
            url: `https://didtheylikeit.com/shows/${slug}/`, date: lastmod, market: 'nyc',
          });
        }
      }
      // Structure-drift guard (parallel to WET's): sitemaps that fetch but
      // parse to ZERO <url> entries mean the regex no longer matches DTLI's
      // markup — fail loudly rather than report a clean 0-candidate run.
      if (totalEntries === 0) throw new Error('DTLI sitemap format drift: fetched sitemaps parsed to 0 entries');
      if (noLastmod > 0) console.log(`DTLI: ${noLastmod} entries without <lastmod> skipped (no recency signal)`);
      console.log(`DTLI: ${found} show pages touched within ${days}d (of ${totalEntries} entries in last 2 sitemaps)`);
      sourcesOk++;
    } catch (e) {
      console.error(`DTLI source failed: ${e.message}`);
    }
  }

  if (sourcesTried > 0 && sourcesOk === 0) {
    console.error('All sources failed — detector blind, failing the run.');
    return 1;
  }

  const candidates = [
    ...findUnmatchedCandidates(items.filter(i => i.market === 'west-end'), weIndex),
    ...findUnmatchedCandidates(items.filter(i => i.market === 'nyc'), nycIndex),
  ];
  console.log(`\n${candidates.length} missing-show candidate(s) of ${items.length} recent items:`);
  for (const c of candidates) console.log(`  [${c.source}] "${c.title}" — ${c.url}`);

  const auditDir = path.join(__dirname, '..', 'data', 'audit');
  const statePath = path.join(auditDir, 'reverse-discovery-state.json');
  const outPath = path.join(auditDir, 'reverse-discovery-candidates.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }

  const nowIso = new Date().toISOString();
  const fresh = candidates.filter(c => !state[candidateKey(c)]);

  if (dryRun) {
    console.log(`\n--dry-run: ${fresh.length} would be newly alerted; no writes.`);
    return 0;
  }

  for (const c of fresh) state[candidateKey(c)] = { firstSeen: nowIso, title: c.title, source: c.source };
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: nowIso, windowDays: days, candidates }, null, 2) + '\n');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${outPath} (${candidates.length}) — ${fresh.length} new since last run`);

  // Surfacing channel is the DAILY DIGEST: health-check.js reads the
  // candidates file (reverseDiscoveryBacklogResults) — same pattern as
  // detect-ob-closings. sendAlert without email:true is LOG-ONLY by design
  // (alert-volume policy), so this just annotates the CI step output.
  if (fresh.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');
    await sendAlert({
      severity: 'warning',
      title: `Reverse discovery: ${fresh.length} reviewed show(s) missing from shows.json`,
      description: fresh.map(c =>
        `**${c.title}** (${c.source}) — ${c.url}\nAdd: validate via \`node scripts/validate-show-venue.js\` then stub per CLAUDE.md §3`
      ).join('\n\n').slice(0, 3500),
    });
  }
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, hasHelpFlag, USAGE };
