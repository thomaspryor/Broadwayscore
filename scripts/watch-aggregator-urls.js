#!/usr/bin/env node
/**
 * Aggregator URL fast-watcher.
 *
 * Runs on a 5-min cron during opening-night windows. For each show with
 * openingDate === today (America/New_York), tries to discover the BWW
 * Review Roundup URL and the DTLI show-page URL. When either is newly
 * found, dispatches opening-night-poller.yml with the override URL so
 * the existing aggregator extractors pick it up immediately.
 *
 * Why this exists:
 *   The orchestrator polls every ~13 min and hits both aggregators each
 *   cycle, but on opening night that latency means we miss the first 30-60
 *   min of reviews dropping. This watcher tightens the discovery loop to
 *   ~5 min for the two highest-value aggregators (BWW RR, DTLI) without
 *   re-running expensive layers (SERP, RSS, site search).
 *
 * Discovered URLs flow ONLY into existing aggregator extractors via the
 * poller's bww_roundup_url override input. They are never registered as
 * outlet-level reviews — the contamination guard is the aggregator
 * extractor's per-critic emission (extractBWWRoundupReviews etc).
 *
 * Usage:
 *   node scripts/watch-aggregator-urls.js               # production
 *   node scripts/watch-aggregator-urls.js --dry-run     # discover only, no dispatch
 *   node scripts/watch-aggregator-urls.js --show=ID     # force-target a specific show
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCED_SHOW = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const SLUG_MAP_PATH = path.join(__dirname, '..', 'data', 'dtli-slug-map.json');
const DTLI_SITEMAP_INDEX = 'https://didtheylikeit.com/sitemap_index.xml';

function todayET() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

function loadSlugMap() {
  try { return JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf8')); }
  catch { return { _meta: {}, shows: {} }; }
}

function findActiveOpenings(shows) {
  if (FORCED_SHOW) {
    const s = shows.find(x => x.id === FORCED_SHOW);
    return s ? [s] : [];
  }
  const today = todayET();
  return shows.filter(s => {
    if (s.openingDate !== today) return false;
    const cat = s.category || 'broadway';
    return cat === 'broadway' || cat === 'off-broadway';
  });
}

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard-Watcher/1.0)',
        'Accept': 'text/xml, application/xml, */*',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return httpGet(loc.startsWith('http') ? loc : `https://didtheylikeit.com${loc}`, timeoutMs).then(resolve);
      }
      if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: true, body }));
    });
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Probe DTLI sitemaps for any show-page slug matching this show.
 * Returns the matched slug or null. Free (plain HTTPS, no Cloudflare).
 *
 * Match strategy mirrors discover-dtli-slugs.js:matchDtliSlug — we look
 * for slugs that share a token-base or title-base with the show. The
 * full matching logic lives there for cross-show ambiguity resolution;
 * here we only care if THIS show has a candidate, so a simpler match
 * is sufficient.
 */
async function discoverDtliSlugForShow(show) {
  const indexRes = await httpGet(DTLI_SITEMAP_INDEX);
  if (!indexRes.ok) return { slug: null, error: `sitemap-index ${indexRes.status || indexRes.error}` };

  const sitemapUrls = [];
  const idxRegex = /<loc>(https:\/\/didtheylikeit\.com\/[^<]*sitemap[^<]*\.xml)<\/loc>/g;
  let m;
  while ((m = idxRegex.exec(indexRes.body)) !== null) {
    if (m[1].includes('shows')) sitemapUrls.push(m[1]);
  }
  if (sitemapUrls.length === 0) {
    sitemapUrls.push('https://didtheylikeit.com/shows-sitemap.xml');
  }

  const titleSlug = slugify(show.title);
  const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
  const idBase = show.id.replace(/-\d{4}$/, '');
  const candidates = new Set([titleSlug, titleNoArticle, idBase]);

  const allSlugs = [];
  for (const sm of sitemapUrls) {
    const res = await httpGet(sm);
    if (!res.ok) continue;
    const re = /<loc>https:\/\/didtheylikeit\.com\/shows\/([^/]+)\/<\/loc>/g;
    let mm;
    while ((mm = re.exec(res.body)) !== null) {
      allSlugs.push(mm[1]);
    }
  }

  for (const slug of allSlugs) {
    const stripped = slug
      .replace(/-\d+$/, '')
      .replace(/-bway$|-broadway$|-revival$|-the-musical$|-review$|-reviews$/, '');
    if (candidates.has(slug) || candidates.has(stripped)) {
      return { slug, total: allSlugs.length };
    }
  }
  return { slug: null, total: allSlugs.length };
}

async function checkBwwRoundup(show) {
  if (show.bwwRoundupUrl) {
    return { skipped: true, reason: 'already-known', url: show.bwwRoundupUrl };
  }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    return { skipped: true, reason: 'no-browserbase-creds' };
  }
  try {
    const result = await discoverBwwRoundupUrl(show);
    return { url: result.url, candidates: result.candidates.length };
  } catch (err) {
    return { error: err.message };
  }
}

function dispatchPoller(showId, overrides) {
  const args = ['workflow', 'run', 'opening-night-poller.yml', '-f', `show_id=${showId}`];
  if (overrides.bwwRoundupUrl) {
    args.push('-f', `bww_roundup_url=${overrides.bwwRoundupUrl}`);
  }
  const result = spawnSync('gh', args, { stdio: 'pipe', timeout: 30000 });
  return {
    exitCode: result.status,
    output: ((result.stdout || '') + (result.stderr || '')).toString(),
  };
}

(async () => {
  const shows = loadShows();
  const openings = findActiveOpenings(shows);
  const today = todayET();

  console.log(`[watch] ${today} ET — ${openings.length} show(s) opening today (broadway/off-broadway)`);
  if (openings.length === 0) {
    console.log('[watch] Nothing to do.');
    process.exit(0);
  }

  const slugMap = loadSlugMap();
  let dispatched = 0;
  let bwwFoundAny = false;
  let dtliFoundAny = false;

  for (const show of openings) {
    console.log(`\n[watch] ${show.id} — "${show.title}"`);
    const overrides = {};
    let needsDispatch = false;

    // BWW RR via Browserbase (existing discoverBwwRoundupUrl)
    const bwwResult = await checkBwwRoundup(show);
    if (bwwResult.skipped) {
      console.log(`  BWW RR: ${bwwResult.reason}${bwwResult.url ? ' (' + bwwResult.url + ')' : ''}`);
    } else if (bwwResult.error) {
      console.log(`  BWW RR error: ${bwwResult.error}`);
    } else if (bwwResult.url) {
      console.log(`  ✅ BWW RR discovered: ${bwwResult.url}`);
      overrides.bwwRoundupUrl = bwwResult.url;
      needsDispatch = true;
      bwwFoundAny = true;
    } else {
      console.log(`  BWW RR: not yet published (${bwwResult.candidates} anchors checked)`);
    }

    // DTLI via plain HTTPS sitemap (free)
    const known = slugMap.shows && slugMap.shows[show.id];
    const dtliResult = await discoverDtliSlugForShow(show);
    if (dtliResult.error) {
      console.log(`  DTLI error: ${dtliResult.error}`);
    } else if (dtliResult.slug) {
      if (known === dtliResult.slug) {
        console.log(`  DTLI slug: ${dtliResult.slug} (already mapped)`);
      } else {
        console.log(`  ✅ DTLI slug ${known ? 'CHANGED' : 'NEW'}: ${dtliResult.slug}${known ? ` (was ${known})` : ''}`);
        // Update slug map in place
        slugMap.shows = slugMap.shows || {};
        slugMap.shows[show.id] = dtliResult.slug;
        slugMap._meta = slugMap._meta || {};
        slugMap._meta.lastUpdated = new Date().toISOString();
        if (!DRY_RUN) {
          fs.writeFileSync(SLUG_MAP_PATH, JSON.stringify(slugMap, null, 2) + '\n');
        }
        needsDispatch = true;
        dtliFoundAny = true;
      }
    } else {
      console.log(`  DTLI: not yet in sitemap (${dtliResult.total} show pages scanned)`);
    }

    if (needsDispatch) {
      if (DRY_RUN) {
        console.log(`  [dry-run] Would dispatch opening-night-poller.yml with overrides=${JSON.stringify(overrides)}`);
      } else {
        const d = dispatchPoller(show.id, overrides);
        if (d.exitCode === 0) {
          console.log(`  ✅ Dispatched opening-night-poller.yml`);
          dispatched++;
        } else {
          console.log(`  ❌ Dispatch failed (exit ${d.exitCode}): ${d.output.slice(0, 300)}`);
        }
      }
    }
  }

  console.log(`\n[watch] Summary: ${dispatched} dispatch(es), bww=${bwwFoundAny}, dtli=${dtliFoundAny}`);
  process.exit(0);
})().catch(err => {
  console.error(`[watch] Unhandled error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
