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

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

const MIN_VOTES = 1; // No floor — consistent with ShowScore/Mezzanine (weighting handles low counts)
const STATS_DELAY_MS = 2000; // 2s between show-stats requests
const USER_AGENT = 'Theatr/184 CFNetwork/3860.400.51 Darwin/25.3.0';

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsPath = path.join(__dirname, '../data/shows.json');

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

  const { status, data } = await httpsRequest('https://appapi.theatr-app.com/v1/auth/access-tokens', {
    method: 'POST',
    body: { refreshToken },
  });

  if (!data.success) {
    throw new Error(`Auth refresh failed: ${JSON.stringify(data)}`);
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

function normalize(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/g, '')
    .trim();
}

// Manual overrides: Theatr name → our show ID
const THEATR_OVERRIDES = {
  'Sunset Blvd.': 'sunset-boulevard-2024',
  'BOOP! The Betty Boop Musical': 'boop-2025',
  'A Wonderful World': 'a-wonderful-world-the-louis-armstrong-musical-2024',
  'Buena Vista Social Club™': 'buena-vista-social-club-2025',
  // 'Ben Platt: Live at the Palace' — not in shows.json (special engagement)
};

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

  return matches;
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
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
