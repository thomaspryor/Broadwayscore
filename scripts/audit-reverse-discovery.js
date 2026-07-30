#!/usr/bin/env node
/**
 * Reverse discovery audit — alert-only detector for shows the aggregators
 * are reviewing that are NOT in shows.json.
 *
 * Sources (v2, see task #477):
 *   - WE/OWE: WestEndTheatre.com WP-API, category 10 (review roundups).
 *     WET publishes a roundup for every notable WE/OWE opening — a roundup
 *     whose show title matches nothing in shows.json is a missing show.
 *   - BW/OB:  DTLI shows-sitemap entries (last 2 sitemaps) with a recent
 *     lastmod. DTLI creates/updates a show page around opening night.
 *   - BW/OB:  BroadwayWorld's Google-News sitemap (bwwgnewsbway.cfm) — a
 *     same-day rolling window of ~100 recent Broadway-section articles.
 *     BWW publishes a "Review Roundup: TITLE, ..." article for essentially
 *     every notable BW/OB opening (fetch-bww-roundups.js's hardcoded URL map
 *     covers ~25 of these retroactively; this is the live discovery feed
 *     that map can never provide). Origin: The Gin Game 2026 revival
 *     (Winger/Howard, Housing Works pop-up) — every forward-discovery source
 *     (TodayTix, Playbill OB schedule, off-broadway-venues.json, Show Score,
 *     DTLI) legitimately missed it, and the same-title 1977/1997/2015
 *     entries meant a naive title match would have suppressed even this
 *     source. This is the only source with allowClosedRevival: a BWW
 *     roundup for a title whose only catalogued productions have all closed
 *     is treated as a missing revival, not a match (see reverse-discovery.js
 *     titleMatchesIndex). WET/DTLI don't opt in — their lastmod timestamps
 *     can touch an old page for reasons unrelated to a new production.
 *     The feed is not NYC-exclusive despite its "bway" name — West End/tour/
 *     regional roundups share the same headline shape, so
 *     extractShowTitleFromBwwRoundup filters them out before this source
 *     ever stamps market: 'nyc' on an item.
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
  node scripts/audit-reverse-discovery.js [--dry-run] [--days=N] [--source=wet|dtli|bww|playbill|all]

Options:
  --dry-run     Print candidates; skip state/audit writes and Discord alert
  --days=N      Recency window for source items (default 45)
  --source=X    Limit to one source (default all)
  --help, -h    Show this help

Exit codes: 0 = ran (candidates or not); 1 = every source fetch failed.
Caveat: for WET/DTLI, a same-title revival of a catalogued show will NOT
surface (title matches the older entry) — the WE completeness gate covers
those once added. The bww source is the exception: it treats a title whose
only catalogued productions have all closed as a missing revival.`;

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
    extractShowTitleFromWetRoundup, titleFromDtliSlug, extractShowTitleFromBwwRoundup,
    extractShowTitleFromPlaybillRoundup, resolveMatchedShowId,
    isBwwNonStageTieIn, isBwwNonNycRoundup,
    buildShowTitleIndex, findUnmatchedCandidates, candidateKey,
  } = require('./lib/reverse-discovery');
  const { loadReviewEvidence, mergeEvidence, saveReviewEvidence } = require('./lib/review-evidence');

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

  // ── Source 3: BWW Google-News sitemap (BW/OB) ──
  // Same-day rolling window (~100 items) of the Broadway-section news feed —
  // covers a per-show "Review Roundup: TITLE, ..." article the day it posts,
  // unlike fetch-bww-roundups.js's static per-show URL map (never a
  // discovery source). allowClosedRevival is scoped to THIS source only:
  // a roundup for a title whose only catalogued productions have all closed
  // is a missing revival (The Gin Game 2026: only 1977/1997/2015 catalogued,
  // all closed) — WET/DTLI stay conservative since their lastmod can touch
  // an old page for unrelated reasons.
  if (sourceFilter === 'all' || sourceFilter === 'bww') {
    sourcesTried++;
    try {
      const xml = (await fetchPage('https://www.broadwayworld.com/bwwgnewsbway.cfm')).content;
      // Gaps are bounded against </url> so a malformed/missing-tag entry
      // can't bleed a later entry's title/date onto an earlier URL.
      const entries = [...xml.matchAll(
        /<url>\s*<loc>([^<]+)<\/loc>(?:(?!<\/url>)[\s\S])*?<n:title>([^<]+)<\/n:title>(?:(?!<\/url>)[\s\S])*?<n:publication_date>([^<]+)<\/n:publication_date>(?:(?!<\/url>)[\s\S])*?<\/url>/g
      )];
      if (entries.length === 0) throw new Error('BWW gnews sitemap parsed to 0 <url> entries');
      let parsed = 0, roundups = 0, filtered = 0;
      for (const [, url, rawTitle, pubDate] of entries) {
        const ts = Date.parse(pubDate);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const isRoundupShaped = /^Review\s+Roundup:/i.test(rawTitle);
        if (isRoundupShaped) roundups++;
        const title = extractShowTitleFromBwwRoundup(rawTitle);
        if (!title) {
          // Deliberate filters (non-stage tie-in, non-NYC market) are not
          // parse failures — count them so the drift guard can subtract them.
          if (isRoundupShaped && (isBwwNonStageTieIn(rawTitle) || isBwwNonNycRoundup(rawTitle))) filtered++;
          continue;
        }
        parsed++;
        items.push({ title, source: 'bww-roundup', url, date: pubDate, market: 'nyc' });
      }
      // Same structure-drift guard as WET/DTLI: recent roundup-shaped titles
      // that all fail to parse means the title format changed underneath us.
      // Deliberately-filtered items don't count against the guard — a window
      // whose only roundups are movie tie-ins or West End/tour items is a
      // normal quiet NYC day, not drift.
      if (roundups > filtered && parsed === 0) {
        throw new Error(`BWW title-format drift: ${roundups} roundup posts (${filtered} deliberately filtered), 0 parsed`);
      }
      console.log(`BWW: ${parsed} roundups within ${days}d (of ${entries.length} recent articles, ${filtered} filtered as tie-in/non-NYC)`);
      sourcesOk++;
    } catch (e) {
      console.error(`BWW source failed: ${e.message}`);
    }
  }

  // ── Source 4: Playbill news RSS (BW/OB) ──
  // Roundup headlines are "Reviews: What Do Critics Think of TITLE …?" —
  // Playbill publishes one for essentially every notable NYC opening, same
  // day the reviews drop (Broad Strokes, 2026-07-28). The RSS window is
  // shallow (~25 items / a few days), so this source's value is FRESH
  // openings — the sitemap-based sources carry the longer window.
  if (sourceFilter === 'all' || sourceFilter === 'playbill') {
    sourcesTried++;
    try {
      const xml = (await fetchPage('https://playbill.com/rss/news')).content;
      const entries = [...xml.matchAll(
        /<item>(?:(?!<\/item>)[\s\S])*?<title>([^<]+)<\/title>(?:(?!<\/item>)[\s\S])*?<link>([^<]+)<\/link>(?:(?!<\/item>)[\s\S])*?<dc:date>([^<]+)<\/dc:date>(?:(?!<\/item>)[\s\S])*?<\/item>/g
      )];
      if (entries.length === 0) throw new Error('Playbill RSS parsed to 0 <item> entries');
      let parsed = 0, roundups = 0;
      for (const [, rawTitle, url, pubDate] of entries) {
        const ts = Date.parse(pubDate);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        if (/^Reviews?:/i.test(rawTitle)) roundups++;
        const title = extractShowTitleFromPlaybillRoundup(rawTitle);
        if (!title) continue;
        parsed++;
        items.push({ title, source: 'playbill-roundup', url: url.trim(), date: pubDate.trim(), market: 'nyc' });
      }
      // Same title-format drift guard as the other roundup sources.
      if (roundups > 0 && parsed === 0) throw new Error(`Playbill title-format drift: ${roundups} "Reviews:" posts, 0 parsed`);
      console.log(`Playbill: ${parsed} roundups within ${days}d (of ${entries.length} RSS items)`);
      sourcesOk++;
    } catch (e) {
      console.error(`Playbill source failed: ${e.message}`);
    }
  }

  if (sourcesTried > 0 && sourcesOk === 0) {
    console.error('All sources failed — detector blind, failing the run.');
    return 1;
  }

  // ── Evidence recording (Sprint A, v2 reconciler plan) ──
  // The MATCHED complement of the missing-show candidates below: a roundup
  // whose title resolves to exactly one non-closed catalogued show is proof
  // that show has published reviews RIGHT NOW — recorded to
  // data/audit/review-evidence.json so opening-night selection and the
  // coverage ledger can anchor on it even when openingDate is null/wrong or
  // status is stuck (the Broad Strokes class). DTLI is excluded: its lastmod
  // can touch an old page for reasons unrelated to reviews.
  const EVIDENCE_SOURCES = new Set(['wet-roundup', 'bww-roundup', 'playbill-roundup']);
  const evidenceItems = [];
  for (const it of items) {
    if (!EVIDENCE_SOURCES.has(it.source)) continue;
    const index = it.market === 'west-end' ? weIndex : nycIndex;
    const showId = resolveMatchedShowId(it.title, index);
    if (showId) evidenceItems.push({ showId, source: it.source, url: it.url, date: it.date.split('T')[0] });
  }
  console.log(`\nEvidence: ${evidenceItems.length} roundup item(s) matched to catalogued shows`);

  const candidates = [
    ...findUnmatchedCandidates(items.filter(i => i.market === 'west-end'), weIndex),
    ...findUnmatchedCandidates(items.filter(i => i.market === 'nyc' && i.source !== 'bww-roundup'), nycIndex),
    ...findUnmatchedCandidates(
      items.filter(i => i.market === 'nyc' && i.source === 'bww-roundup'), nycIndex,
      { allowClosedRevival: true }
    ),
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
    for (const e of evidenceItems) console.log(`  evidence: ${e.showId} <- [${e.source}] ${e.url}`);
    return 0;
  }

  if (evidenceItems.length > 0) {
    const merged = mergeEvidence(loadReviewEvidence(), evidenceItems);
    saveReviewEvidence(merged);
    console.log(`Wrote data/audit/review-evidence.json (${Object.keys(merged).length} show(s) with fresh evidence)`);
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
  // Not routed through owner-alert-router — this already has its own cooldown:
  // `fresh` above is computed against statePath, keyed per candidate, so a
  // given show only ever appears here once (permanently, not time-boxed) until
  // its key is cleared; re-alerting the router's ledger on top would be
  // redundant dedup on dedup.
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
