#!/usr/bin/env node
/**
 * Scrape Theatr audience data via their API and update audience-buzz.json
 *
 * Theatr (theatr-app.com) is a Broadway community app with per-show sentiment data:
 * numLikes, numDislikes, numMixed, numWatched, numInterested.
 *
 * Score conversion: weighted approval = ((likes + mixed×0.5) / totalVotes) × 100
 *
 * Auth: Theatr uses self-issued JWTs with a 30-day refresh token that rolls on each use.
 * The script refreshes the access token automatically and saves the new refresh token.
 *
 * Usage:
 *   node scripts/scrape-theatr-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run] [--verbose]
 *
 * Environment variables:
 *   THEATR_REFRESH_TOKEN - Theatr refresh token (required, will be updated after run)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isLondonMarket } = require('./lib/venue-classification');
const { normalizeTitle, titleTokens, jaccard } = require('./lib/title-match');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsFilterArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const showsFilter = showsFilterArg ? new Set(showsFilterArg.split(',').map(s => s.trim()).filter(Boolean)) : null;
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

const MIN_VOTES = 1; // No floor — consistent with ShowScore/Mezzanine (weighting handles low counts)
const STATS_DELAY_MS = 2000; // 2s between show-stats requests
const USER_AGENT = 'Theatr/184 CFNetwork/3860.400.51 Darwin/25.3.0';

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsPath = path.join(__dirname, '../data/shows.json');
// Image cache shared with fetch-show-images-auto.js so that script NEVER
// needs to call Theatr API itself. Only this script touches Theatr auth.
const theatrImageCachePath = path.join(__dirname, '../data/theatr-image-cache.json');

let audienceBuzz, showsData, showMapById;

// ---- HTTP helpers ----

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'accept': '*/*',
        'user-agent': USER_AGENT,
        ...options.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          reject(new Error(`Invalid JSON from ${url}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });

    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Auth ----

let accessToken = null;
let latestRefreshToken = null;

/**
 * Read the git-persisted fallback token, if any. Written by update-theatr.yml
 * into the private core-data repo when `gh secret set` was rate-limited after
 * the old token was already burned (Jun 7 2026 incident, run 27100884711) —
 * git pushes are not REST-rate-limited, so the rotated token survives there.
 * checkout-core-data copies it into data/ at job start.
 */
function readFallbackRefreshToken() {
  try {
    const fbPath = path.join(__dirname, '../data/theatr-refresh-token-fallback.json');
    if (!fs.existsSync(fbPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(fbPath, 'utf8'));
    return (parsed && typeof parsed.refreshToken === 'string' && parsed.refreshToken) || null;
  } catch (e) {
    console.warn(`  Could not read fallback token file: ${e.message}`);
    return null;
  }
}

async function refreshAccessToken() {
  // Allow direct access token for local testing
  if (process.env.THEATR_ACCESS_TOKEN) {
    accessToken = process.env.THEATR_ACCESS_TOKEN;
    console.log('  Using direct access token from THEATR_ACCESS_TOKEN');
    return { accessToken, refreshToken: null };
  }

  const refreshToken = latestRefreshToken || process.env.THEATR_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('THEATR_REFRESH_TOKEN or THEATR_ACCESS_TOKEN environment variable must be set');
  }

  let { status, data } = await httpsRequest('https://appapi.theatr-app.com/v1/auth/access-tokens', {
    method: 'POST',
    body: { refreshToken },
  });

  // Primary (secret) token rejected on FIRST auth: the previous run may have
  // rotated successfully but failed to persist the secret (rate-limited
  // gh secret set). Its rotated token lives in the git fallback — try it.
  if (!data.success && !latestRefreshToken) {
    const fallback = readFallbackRefreshToken();
    if (fallback && fallback !== refreshToken) {
      console.log('  Secret token rejected — retrying with git-persisted fallback (data/theatr-refresh-token-fallback.json)');
      ({ status, data } = await httpsRequest('https://appapi.theatr-app.com/v1/auth/access-tokens', {
        method: 'POST',
        body: { refreshToken: fallback },
      }));
    }
  }

  if (!data.success) {
    throw new Error(`Auth refresh failed: ${JSON.stringify(data)}`);
  }

  // A success response without a new refreshToken means the old token is
  // burned with nothing to persist — writeFileSync(path, undefined) would
  // throw an opaque TypeError. Fail with the full response instead so the
  // operator knows a re-capture is needed (rotate-theatr-token.yml has the
  // same guard).
  if (!data.content || !data.content.accessToken || !data.content.refreshToken) {
    throw new Error(`Auth succeeded but response is missing accessToken/refreshToken — old token is burned, re-capture required. Response: ${JSON.stringify(data)}`);
  }

  accessToken = data.content.accessToken;
  latestRefreshToken = data.content.refreshToken;
  console.log('  Access token refreshed successfully');

  // Persist new refresh token IMMEDIATELY — if the script crashes later,
  // we won't lose the rotated token (old one is already burned).
  const tokenPath = path.join(__dirname, '../data/theatr-refresh-token.tmp');
  fs.writeFileSync(tokenPath, latestRefreshToken);

  return { accessToken, refreshToken: latestRefreshToken };
}

function authHeaders() {
  return { authorization: `Bearer ${accessToken}` };
}

// ---- Theatr API ----

async function fetchAllShows() {
  const { data } = await httpsRequest('https://appapi.theatr-app.com/shows/query', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      filters: [{ field: 'genreCategory', op: '==', value: 'Theatre' }],
      orderBy: [{ field: 'totalWatchedUsers', direction: 'desc' }],
      pageSize: 9999,
    },
  });

  if (!data.success) throw new Error(`Shows query failed: ${data.message}`);
  return data.content.records;
}

async function fetchShowStats(showId) {
  const { data } = await httpsRequest(`https://appapi.theatr-app.com/show-stats/${showId}`, {
    headers: authHeaders(),
  });

  if (!data.success) return null;
  return data.content;
}

// ---- Title matching ----

// normalize() lives in scripts/lib/title-match.js (shared across audience
// scrapers, unit-tested at scripts/lib/title-match.test.js). Migrating this
// scraper closes the drift gap that caused the 2026-04-28 What Happened Was
// incident \u2014 Theatr's normalize was an older copy of the same logic.
const normalize = normalizeTitle;

// Manual overrides: Theatr name → our show ID
const THEATR_OVERRIDES = {
  'Sunset Blvd.': 'sunset-boulevard-2024',
  'BOOP! The Betty Boop Musical': 'boop-2025',
  'A Wonderful World': 'a-wonderful-world-the-louis-armstrong-musical-2024',
  'Buena Vista Social Club™': 'buena-vista-social-club-2025',
  "Arthur Miller's Death of a Salesman": 'death-of-a-salesman-2026',
  // 'Ben Platt: Live at the Palace' — not in shows.json (special engagement)
};

// Shows whose normalized title collides with a closed historical Broadway
// revival in shows.json. The matcher (matchTheatrToShows below) picks the
// most-recent-by-openingDate among same-titled candidates, so a modern
// Theatr listing (touring / Encores! / regional / OB) silently attaches
// to the old Broadway revival. Until the structural fix lands
// (Notion 36a637c5-416f-8199-baf6-ef195e30c59b), we refuse to write
// Theatr data to these IDs.
const THEATR_SKIP_SHOWS = new Set([
  'pal-joey-2008',
  'show-boat-1994',
  'the-merchant-of-venice-2010',
]);

function matchTheatrToShows(theatrShows, ourShows) {
  const matches = [];
  const today = new Date().toISOString().split('T')[0];

  // Build lookup by normalized title
  const ourByNorm = new Map();
  for (const show of ourShows) {
    const norm = normalize(show.title);
    if (!ourByNorm.has(norm)) ourByNorm.set(norm, []);
    ourByNorm.get(norm).push(show);
  }

  for (const theatr of theatrShows) {
    const theatrNorm = normalize(theatr.name);

    // Check manual override first
    if (THEATR_OVERRIDES[theatr.name]) {
      const overrideId = THEATR_OVERRIDES[theatr.name];
      const show = ourShows.find(s => s.id === overrideId);
      if (show) {
        matches.push({ theatr, show, confidence: 'override' });
        continue;
      }
    }

    // Exact normalized title match
    const candidates = ourByNorm.get(theatrNorm);
    if (candidates && candidates.length > 0) {
      // If multiple (revivals/markets), prefer matching category but allow transfers
      const isBroadway = theatr.eventCategory === 'Broadway';
      const started = candidates.filter(s => {
        const start = s.previewsStartDate || s.openingDate;
        return !start || start <= today;
      });
      // Prefer same-category matches, fall back to any non-west-end
      const sameCategory = started.filter(s => {
        if (isBroadway) return !s.category || s.category === 'broadway';
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : started.filter(s => !isLondonMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ theatr, show: best, confidence: 'exact' });
        continue;
      }
    }

    // Prefix matching (handles "Two Strangers (Carry a Cake Across New York)" vs "Two Strangers")
    const isBroadway = theatr.eventCategory === 'Broadway';
    const prefixCandidates = [];
    for (const show of ourShows) {
      const showNorm = normalize(show.title);
      const shorter = theatrNorm.length <= showNorm.length ? theatrNorm : showNorm;
      const longer = theatrNorm.length <= showNorm.length ? showNorm : theatrNorm;

      if (shorter.length >= 8 && longer.startsWith(shorter + ' ')) {
        const ratio = shorter.length / longer.length;
        if (ratio >= 0.3) {
          const start = show.previewsStartDate || show.openingDate;
          if (!start || start <= today) {
            prefixCandidates.push(show);
          }
        }
      }
    }
    if (prefixCandidates.length > 0) {
      // Apply same category/recency filtering as exact matches
      const sameCategory = prefixCandidates.filter(s => {
        if (isBroadway) return !s.category || s.category === 'broadway';
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : prefixCandidates.filter(s => !isLondonMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ theatr, show: best, confidence: 'prefix' });
      }
    }
  }

  // Deduplicate: when multiple Theatr entries map to the same show ID,
  // keep only the one with the most watched users. Without this, the last
  // match silently overwrites the first — which killed DoaS 2026 (42-vote
  // entry overwritten by a 1-vote duplicate listing).
  const byShowId = new Map();
  for (const m of matches) {
    const id = m.show.id;
    if (THEATR_SKIP_SHOWS.has(id)) continue;
    const watched = m.theatr.totalWatchedUsers || 0;
    if (!byShowId.has(id) || watched > (byShowId.get(id).theatr.totalWatchedUsers || 0)) {
      byShowId.set(id, m);
    }
  }
  return [...byShowId.values()];
}

// ---- Score conversion ----

function theatrToScore(stats) {
  const likes = stats.numLikes || 0;
  const dislikes = stats.numDislikes || 0;
  const mixed = stats.numMixed || 0;
  const totalVotes = likes + dislikes + mixed;

  if (totalVotes < MIN_VOTES) return null;

  // Weighted approval: likes = 1.0, mixed = 0.0 (neutral), dislikes = 0.0
  // Mixed = "I have reservations" — not half a recommendation
  const score = (likes / totalVotes) * 100;
  return Math.round(score * 10) / 10; // one decimal
}

// ---- Audience buzz update ----

function updateAudienceBuzz(showId, title, score, reviewCount, stats) {
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
        theatr: null,
      }
    };
  }

  const show = audienceBuzz.shows[showId];
  if (!show.sources) show.sources = {};

  show.sources.theatr = {
    score: Math.round(score),
    reviewCount,
    numLikes: stats.numLikes,
    numDislikes: stats.numDislikes,
    numMixed: stats.numMixed,
    numWatched: stats.numWatched,
    numInterested: stats.numInterested,
  };

  // Recalculate combined score
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score: combined, weights } = calculateCombinedScore(show.sources, showInfo);

  if (combined !== null) {
    show.combinedScore = combined;

    show.designation = getDesignation(combined);

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%`);
    }
  }
}

// ---- Main ----

async function main() {
  console.log('Theatr Audience Data Scraper');
  console.log('============================\n');

  // Load data
  audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
  showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  showMapById = {};
  for (const s of showsData.shows) showMapById[s.id] = s;

  // 1. Auth
  console.log('Refreshing access token...');
  await refreshAccessToken();

  // 2. Fetch all Theatr shows
  console.log('Fetching all Theatr shows...');
  const theatrShows = await fetchAllShows();
  console.log(`Fetched ${theatrShows.length} shows from Theatr`);

  // Separate by category
  const broadway = theatrShows.filter(s => s.eventCategory === 'Broadway');
  const offBroadway = theatrShows.filter(s => s.eventCategory === 'Off & Off-Off Broadway');
  console.log(`  Broadway: ${broadway.length} | Off-Broadway: ${offBroadway.length}\n`);

  // 2b. Populate the image cache file used by fetch-show-images-auto.js.
  // This makes THIS script the single place that calls Theatr API. Image
  // fetching reads from the cache file without needing the refresh token,
  // which eliminates the race where two separate workflows both rotated
  // the token and one of them lost the rotated value.
  if (!dryRun) {
    try {
      const imageRecords = theatrShows
        .filter(r => r.imageUrl || r.verticalPosterUrl || r.bannerImageUrl)
        .map(r => ({
          name: r.name,
          imageUrl: r.imageUrl || null,
          posterUrl: r.verticalPosterUrl || null,
          heroUrl: r.bannerImageUrl || null,
          eventCategory: r.eventCategory || null,
          venue: r.venue || null,
        }));
      fs.writeFileSync(theatrImageCachePath, JSON.stringify({
        lastUpdated: new Date().toISOString(),
        recordCount: imageRecords.length,
        records: imageRecords,
      }, null, 2));
      console.log(`  Wrote ${imageRecords.length} records to theatr-image-cache.json`);
    } catch (e) {
      console.error(`  WARNING: Failed to write image cache: ${e.message}`);
    }
  }

  // 3. Match to our shows
  console.log('Matching to shows.json...');
  const matches = matchTheatrToShows(theatrShows, showsData.shows);
  console.log(`Matched ${matches.length} shows\n`);

  // Apply filters
  let toProcess = matches;
  if (showFilter) {
    toProcess = matches.filter(m => m.show.id === showFilter);
    console.log(`Filtered to show: ${showFilter} (${toProcess.length} matches)`);
  }
  if (showsFilter) {
    toProcess = toProcess.filter(m => showsFilter.has(m.show.id));
    console.log(`Filtered to ${showsFilter.size} shows: ${[...showsFilter].join(', ')} (${toProcess.length} matches)`);
  }
  if (showLimit) {
    toProcess = toProcess.slice(0, showLimit);
    console.log(`Limited to ${showLimit} shows`);
  }

  // 4. Fetch stats for each matched show
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { theatr, show, confidence } = toProcess[i];

    try {
      const stats = await fetchShowStats(theatr.id);
      if (!stats) {
        if (verbose) console.log(`  SKIP ${show.id}: no stats available`);
        skipped++;
        continue;
      }

      const score = theatrToScore(stats);
      if (score === null) {
        if (verbose) console.log(`  SKIP ${show.id}: <${MIN_VOTES} votes (${(stats.numLikes || 0) + (stats.numDislikes || 0) + (stats.numMixed || 0)})`);
        skipped++;
        continue;
      }

      const totalVotes = (stats.numLikes || 0) + (stats.numDislikes || 0) + (stats.numMixed || 0);

      if (!dryRun) {
        updateAudienceBuzz(show.id, show.title, score, totalVotes, stats);
        updated++;
      }

      if ((i + 1) % 25 === 0 || verbose) {
        console.log(`  [${i + 1}/${toProcess.length}] ${show.title}: ${Math.round(score)} (${totalVotes} votes, match=${confidence})`);
      }
    } catch (e) {
      console.error(`  ERROR ${show.id}: ${e.message}`);
      errors++;
    }

    // Rate limit
    if (i < toProcess.length - 1) {
      await sleep(STATS_DELAY_MS);
    }
  }

  console.log(`\nResults: ${updated} updated, ${skipped} skipped, ${errors} errors`);

  // 5. Save
  if (!dryRun && updated > 0) {
    audienceBuzz._meta.lastUpdated = new Date().toISOString();
    if (!audienceBuzz._meta.sources.includes('Theatr')) {
      audienceBuzz._meta.sources.push('Theatr');
    }
    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
    console.log(`Saved audience-buzz.json`);
  }

  // 6. Refresh token already persisted immediately after rotation (line ~113)
  if (latestRefreshToken) {
    console.log(`Refresh token was persisted to data/theatr-refresh-token.tmp`);
  }

  // Summary
  const unmatched = theatrShows.filter(t =>
    !matches.some(m => m.theatr.id === t.id) &&
    (t.totalWatchedUsers || 0) >= 50
  );
  if (unmatched.length > 0 && verbose) {
    console.log(`\nUnmatched Theatr shows with 50+ watched (${unmatched.length}):`);
    for (const u of unmatched.slice(0, 20)) {
      console.log(`  ${u.name} (${u.eventCategory}, watched=${u.totalWatchedUsers})`);
    }
  }

  // Coverage audit: surface unmatched Theatr shows whose title is SIMILAR to one
  // of our open/recent shows that lacks Theatr data — the same class of silent
  // miss that hid Encores La Cage on Mezzanine (a title-drift / override gap).
  // Mirrors scrape-mezzanine-audience.js's audit and writes the same shape so
  // health-check.js's "Audience coverage: open-show gaps" check reads both.
  // Tight by design: only full runs (no --show/--shows), only shows opened
  // since 2015 that lack Theatr, fuzzy match ≥0.6.
  if (!showFilter && !showsFilter && !dryRun) {
    const today = new Date().toISOString().slice(0, 10);
    const candidates = showsData.shows
      .filter(s => !audienceBuzz.shows[s.id]?.sources?.theatr)
      .filter(s => { const o = s.openingDate || s.previewsStartDate; return !o || o >= '2015-01-01'; })
      .map(s => ({ s, t: titleTokens(s.title), year: parseInt((s.openingDate || '').slice(0, 4)) }));

    const flagged = [];
    for (const u of unmatched) {
      const uTokens = titleTokens(u.name || '');
      if (!uTokens.size) continue;
      let best = null;
      for (const c of candidates) {
        if (!c.t.size) continue;
        const j = jaccard(uTokens, c.t);
        if (j < 0.6) continue;
        if (!best || j > best.j) best = { showId: c.s.id, showTitle: c.s.title, showYear: c.year, j };
      }
      if (best) flagged.push({
        theatrName: u.name,
        eventCategory: u.eventCategory,
        watched: u.totalWatchedUsers,
        ratingsCount: u.totalWatchedUsers,
        ourShowId: best.showId,
        ourTitle: best.showTitle,
        ourYear: best.showYear || null,
        jaccard: Number(best.j.toFixed(2)),
      });
    }
    flagged.sort((a, b) => (b.watched || 0) - (a.watched || 0));
    const auditDir = path.join(__dirname, '../data/audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'theatr-coverage.json'),
      JSON.stringify({ lastUpdated: new Date().toISOString(), watchedThreshold: 50, jaccardThreshold: 0.6, count: flagged.length, flagged }, null, 2)
    );
    if (flagged.length > 0) {
      console.log(`\n⚠ Coverage audit: ${flagged.length} Theatr shows look like they should match an open/recent show but don't. Written to data/audit/theatr-coverage.json`);
    }
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

module.exports = { matchTheatrToShows, THEATR_SKIP_SHOWS, refreshAccessToken, readFallbackRefreshToken };
