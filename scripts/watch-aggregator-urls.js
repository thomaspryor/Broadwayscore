#!/usr/bin/env node
/**
 * Aggregator URL fast-watcher.
 *
 * Runs on a 5-min cron (best-effort, GitHub throttles it) and, during opening-night
 * windows, in loop mode started by the orchestrator (BRO-6628). For each show with
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
 *   node scripts/watch-aggregator-urls.js --list-active # print today's Broadway/Off-Broadway opening ids, exit
 *   node scripts/watch-aggregator-urls.js --loop-minutes=270 [--interval-seconds=300]
 *       # loop mode (BRO-6628): re-run every interval for up to N minutes in this one
 *       # process; the opening set is fixed at start so the window survives midnight ET
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { discoverBwwRoundupUrl, scoreCandidate } = require('./lib/bww-rr-discover');
const { fetchPage } = require('./lib/scraper');
const { findInFlightCoverage } = require('./lib/poller-idempotency');
const { findConflictingKey } = require('./lib/cache-collision');
const W = require('./lib/watcher-loop');

const DRY_RUN = process.argv.includes('--dry-run');
const LIST_ACTIVE = process.argv.includes('--list-active');
const argNum = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); const n = a ? Number(a.split('=')[1]) : NaN; return Number.isFinite(n) && n >= 0 ? n : dflt; };
const LOOP_MINUTES = argNum('loop-minutes', 0);
const INTERVAL_SECONDS = Math.max(argNum('interval-seconds', 300), 1);
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

/**
 * Fast BWW homepage scrape via fetchPage(). BWW features new Review Roundups
 * in the homepage carousel the moment they publish — typically 5-15 min ahead
 * of when the same URL appears on reviews.php (different Cloudflare cache lane).
 *
 * Why fetchPage and not plain HTTPS: tested 2026-04-25 — plain curl/node fetch
 * works from a residential IP (Mac) but returns 403 from GitHub Actions IPs
 * (Cloudflare bot block). fetchPage's provider chain (Bright Data → SB →
 * Playwright) handles this transparently. Costs ~$0.005/call via BD vs
 * ~$0.10/call for the Browserbase reviews.php scrape.
 *
 * Caught Joe Turner 2026-04-25 when reviews.php scrape returned 6 anchors
 * none matching, but homepage had the RR as the top featured article.
 */
async function discoverBwwRoundupFromHomepage(show) {
  let html;
  try {
    const res = await fetchPage('https://www.broadwayworld.com/', { renderJs: false });
    html = res?.content;
  } catch (err) {
    return { url: null, anchors: 0, error: err.message };
  }
  if (!html) return { url: null, anchors: 0, error: 'empty-response' };
  const re = /href="(\/article\/Review-Roundup-[^"]+)"/g;
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    found.add('https://www.broadwayworld.com' + m[1]);
  }
  const anchors = [...found];
  const candidates = anchors
    .map(url => ({ url, score: scoreCandidate(url, show) }))
    .filter(c => c.score >= 10)
    .sort((a, b) => b.score - a.score);
  return { url: candidates[0]?.url || null, anchors: anchors.length, candidates: candidates.length };
}

async function checkBwwRoundup(show) {
  if (show.bwwRoundupUrl) {
    return { skipped: true, reason: 'already-known', url: show.bwwRoundupUrl };
  }

  // Layer 1: free homepage scrape (plain HTTPS, fastest)
  try {
    const home = await discoverBwwRoundupFromHomepage(show);
    if (home.url) {
      return { url: home.url, source: 'homepage', anchors: home.anchors };
    }
    if (home.error) {
      console.log(`  BWW homepage scrape error: ${home.error}`);
    }
  } catch (err) {
    console.log(`  BWW homepage scrape exception: ${err.message}`);
  }

  // Layer 2: Browserbase reviews.php scrape (paid, fallback for non-homepage features)
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    return { url: null, source: 'homepage-only', reason: 'no-browserbase-creds' };
  }
  try {
    const result = await discoverBwwRoundupUrl(show);
    return {
      url: result.url,
      source: 'reviews.php',
      anchors: result.candidates.length,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Tonight #7 (Joe Turner postmortem): when 3 watcher ticks and an orchestrator
// dispatch all targeted the same show within ~10 min, the resulting concurrent
// pollers exhausted push-with-retry's 5 attempts and triggered a GitHub
// installation rate-limit (HTTP 403) on rebuild dispatch. Idempotency check
// here prevents the redundant dispatches in the first place; the per-show
// concurrency group on opening-night-poller.yml is the backstop.
//
// findInFlightCoverage (without an override URL) ALSO matches "Opening Night Poller — auto" runs
// (dispatched by update-show-status.yml line 943 and the orchestrator's
// multi-show branch). An auto run iterates ALL of today's openings via
// opening-night-poller.js, so it covers every show the watcher might target.
// Without this, the watcher's targeted dispatch races against an in-flight
// auto run for the same show — re-introducing the Joe Turner push storm.
// (Caught in /ship-check 2026-04-26 by both Claude general-purpose and
// Codex reviewers, independently.)
//
// BRO-4209: a dispatch carrying a bww_roundup_url override is exempt from the
// auto-run skip (the auto run never sees the override). The runs then execute
// in parallel (different concurrency groups); accepted per BRO-4273, writes
// rely on push-with-retry.sh. Same-show targeted runs still skip.
//
// --limit=50: opening nights with 8+ pollers per orchestrator iteration
// can push active runs past index 20 once a few finish. limit=50 covers
// roughly the last 4 hours on the busiest nights.
//
// Fail-open: if the gh API hiccups, we still dispatch — better a redundant
// poller than a missed BWW URL discovery on opening night.
function pollerInFlightForShow(showId, hasOverrideUrl = false) {
  const result = spawnSync(
    'gh',
    [
      'run', 'list',
      '--workflow=opening-night-poller.yml',
      '--limit=50',
      '--json', 'databaseId,displayTitle,status,createdAt',
    ],
    { stdio: 'pipe', timeout: 15000 },
  );
  if (result.status !== 0) {
    return { error: ((result.stderr || '') + (result.stdout || '')).toString().slice(0, 300) };
  }
  let runs;
  try {
    runs = JSON.parse(result.stdout.toString() || '[]');
  } catch (err) {
    return { error: `parse error: ${err.message}` };
  }
  return { run: findInFlightCoverage(runs, showId, { hasOverrideUrl }) };
}

function dispatchPoller(showId, overrides) {
  const inFlight = pollerInFlightForShow(showId, Boolean(overrides.bwwRoundupUrl));
  if (inFlight.error) {
    console.log(`  ⚠️  Idempotency check failed (${inFlight.error}) — proceeding with dispatch`);
  } else if (inFlight.run) {
    const dt = inFlight.run.displayTitle || '';
    const isAuto = dt.endsWith('— auto');
    const coverage = isAuto
      ? `auto poller ${inFlight.run.databaseId} (${inFlight.run.status}) covers all today's openings`
      : `targeted poller ${inFlight.run.databaseId} (${inFlight.run.status}) already running for ${showId}`;
    return {
      exitCode: 0,
      skipped: true,
      reason: coverage,
      output: '',
    };
  }
  const args = ['workflow', 'run', 'opening-night-poller.yml', '-f', `show_id=${showId}`];
  if (overrides.bwwRoundupUrl) {
    args.push('-f', `bww_roundup_url=${overrides.bwwRoundupUrl}`);
  }
  // When we hand the poller a known-good BWW RR URL, SERP becomes a waste:
  // it costs 3-5 min and can return wrong-production results that the poller
  // then has to filter out. We have ground truth — skip the discovery layer
  // we don't need.
  if (overrides.bwwRoundupUrl) {
    args.push('-f', 'skip_serp=true');
  }
  const result = spawnSync('gh', args, { stdio: 'pipe', timeout: 30000 });
  return {
    exitCode: result.status,
    output: ((result.stdout || '') + (result.stderr || '')).toString(),
  };
}

async function pass(openings, ctx) {
  const { slugMap, state } = ctx;
  let dispatched = 0;
  let bwwFoundAny = false;
  let dtliFoundAny = false;

  for (const show of openings) {
    console.log(`\n[watch] ${show.id} — "${show.title}"`);
    const overrides = {};
    let needsDispatch = false;
    let bwwUrlFound = null;
    let dtliSlugFound = null;

    // BWW RR: homepage scrape (free) → reviews.php (Browserbase fallback).
    // Skipped once the URL has been handed to the poller (no repeat Browserbase spend).
    if (W.shouldProbeBww(state, show.id)) {
      const bwwResult = await checkBwwRoundup(show);
      if (bwwResult.skipped) {
        console.log(`  BWW RR: ${bwwResult.reason}${bwwResult.url ? ' (' + bwwResult.url + ')' : ''}`);
      } else if (bwwResult.error) {
        console.log(`  BWW RR error: ${bwwResult.error}`);
      } else if (bwwResult.url) {
        console.log(`  ✅ BWW RR discovered via ${bwwResult.source}: ${bwwResult.url}`);
        overrides.bwwRoundupUrl = bwwResult.url;
        bwwUrlFound = bwwResult.url;
        needsDispatch = true;
        bwwFoundAny = true;
      } else {
        const note = bwwResult.reason ? ` [${bwwResult.reason}]` : '';
        console.log(`  BWW RR: not yet published (${bwwResult.anchors ?? 0} RR anchors scanned)${note}`);
      }
    } else {
      console.log('  BWW RR: already handed to the poller this window');
    }

    // DTLI via plain HTTPS sitemap (free)
    const known = slugMap.shows && slugMap.shows[show.id];
    const dtliResult = await discoverDtliSlugForShow(show);
    // BRO-4060: a DTLI page is one production. If another show id already owns
    // this slug (a same-title revival matched onto the original's page), do
    // not re-point it here; discover-dtli-slugs.js --force with the year rule
    // is the place to move a slug between productions.
    const dtliOwner = dtliResult.slug ? findConflictingKey(slugMap.shows, show.id, dtliResult.slug) : null;
    if (dtliResult.error) {
      console.log(`  DTLI error: ${dtliResult.error}`);
    } else if (dtliResult.slug) {
      if (known === dtliResult.slug) {
        console.log(`  DTLI slug: ${dtliResult.slug} (already mapped)`);
        // Mapped before this process started (or on an earlier pass): nothing new to announce.
        W.markDtliDispatched(state, show.id, dtliResult.slug);
      } else if (dtliOwner) {
        console.log(`  ⚠ DTLI slug ${dtliResult.slug} already mapped to ${dtliOwner} — not assigning it to ${show.id} (cross-show collision)`);
      } else {
        console.log(`  ✅ DTLI slug ${known ? 'CHANGED' : 'NEW'}: ${dtliResult.slug}${known ? ` (was ${known})` : ''}`);
        // Update slug map in place (kept in memory across loop passes)
        slugMap.shows = slugMap.shows || {};
        slugMap.shows[show.id] = dtliResult.slug;
        slugMap._meta = slugMap._meta || {};
        slugMap._meta.lastUpdated = new Date().toISOString();
        if (!DRY_RUN) {
          fs.writeFileSync(SLUG_MAP_PATH, JSON.stringify(slugMap, null, 2) + '\n');
        }
        dtliSlugFound = dtliResult.slug;
        if (W.shouldDispatchDtli(state, show.id, dtliResult.slug)) needsDispatch = true;
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
        if (d.skipped) {
          console.log(`  ⏭  Dispatch skipped — ${d.reason}`);
          // A running poller covers this URL: do not keep re-probing for it.
          if (bwwUrlFound) W.markBwwDispatched(state, show.id, bwwUrlFound);
          if (dtliSlugFound) W.markDtliDispatched(state, show.id, dtliSlugFound);
        } else if (d.exitCode === 0) {
          console.log(`  ✅ Dispatched opening-night-poller.yml`);
          dispatched++;
          if (bwwUrlFound) W.markBwwDispatched(state, show.id, bwwUrlFound);
          if (dtliSlugFound) W.markDtliDispatched(state, show.id, dtliSlugFound);
        } else {
          console.log(`  ❌ Dispatch failed (exit ${d.exitCode}): ${d.output.slice(0, 300)}`);
        }
      }
    }
  }

  console.log(`\n[watch] Summary: ${dispatched} dispatch(es), bww=${bwwFoundAny}, dtli=${dtliFoundAny}`);
  return { done: !DRY_RUN && W.allDone(state, openings.map(s => s.id)) };
}

(async () => {
  const shows = loadShows();
  const openings = findActiveOpenings(shows);
  const today = todayET();

  if (LIST_ACTIVE) {
    console.log(openings.map(s => s.id).join(','));
    process.exit(0);
  }

  console.log(`[watch] ${today} ET — ${openings.length} show(s) opening today (broadway/off-broadway)`);
  if (openings.length === 0) {
    console.log('[watch] Nothing to do.');
    process.exit(0);
  }

  const ctx = { slugMap: loadSlugMap(), state: W.createWatchState() };

  if (LOOP_MINUTES > 0) {
    const deadlineMs = Date.now() + LOOP_MINUTES * 60000;
    console.log(`[watch] loop mode: every ${INTERVAL_SECONDS}s for up to ${LOOP_MINUTES} min (opening set fixed at start)`);
    const r = await W.runLoop({
      pass: (n) => { console.log(`\n[watch] ===== pass ${n} @ ${new Date().toISOString()} =====`); return pass(openings, ctx); },
      intervalMs: INTERVAL_SECONDS * 1000,
      deadlineMs,
      sleep: (ms) => new Promise(res => setTimeout(res, ms)),
      log: (m) => console.log(m),
    });
    console.log(`[watch] loop finished after ${r.iterations} pass(es): ${r.reason}`);
    process.exit(0);
  }

  await pass(openings, ctx);
  process.exit(0);
})().catch(err => {
  console.error(`[watch] Unhandled error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
