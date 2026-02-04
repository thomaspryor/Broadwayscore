#!/usr/bin/env node
/**
 * Scrape Mezzanine audience data via Parse API and update audience-buzz.json
 *
 * Mezzanine (theaterdiary.com) uses a Parse Server backend. This script calls
 * the API directly to fetch all Broadway production ratings, matches them to
 * our shows.json, and updates audience-buzz.json with the Mezzanine source.
 *
 * Usage:
 *   node scripts/scrape-mezzanine-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run] [--verbose]
 *
 * Environment variables:
 *   MEZZANINE_APP_ID       - Parse Application ID (required)
 *   MEZZANINE_SESSION_TOKEN - Parse Session Token (required)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// Config
const APP_ID = process.env.MEZZANINE_APP_ID;
const SESSION_TOKEN = process.env.MEZZANINE_SESSION_TOKEN;

// Manual overrides: our show ID → Mezzanine show name (for titles that differ)
const MEZZANINE_OVERRIDES = {
  'summer-2018': 'Summer: The Donna Summer Musical',
};

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

// Load data
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

/**
 * Query Parse Server API
 */
function queryParse(className, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: '/parse/classes/' + className,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Session-Token': SESSION_TOKEN,
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Authentication failed (${res.statusCode}). Session token may have expired. Re-intercept via mitmproxy to get a fresh token.`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Fetch all productions from Mezzanine with ratings, paginated
 */
async function fetchAllProductions() {
  const all = [];
  let skip = 0;
  const batchSize = 1000;

  while (true) {
    if (verbose) console.log(`  Fetching productions ${skip}–${skip + batchSize}...`);

    const res = await queryParse('Production', {
      limit: batchSize,
      skip: skip,
      where: { ratingsCount: { '$gt': 0 } },
      include: 'show,theater',
      _method: 'GET'
    });

    if (!res.results || res.results.length === 0) break;
    all.push(...res.results);
    skip += res.results.length;

    if (res.results.length < batchSize) break;
  }

  return all;
}

/**
 * Filter to NYC/Broadway productions only
 * Uses Mezzanine's own theater metadata: isBroadway, location, geocodedCity
 */
function filterNYCProductions(productions) {
  return productions.filter(p => {
    const theater = p.theater;
    if (!theater) return false;

    // Primary: Mezzanine's own Broadway flag
    if (theater.isBroadway === true) return true;

    // Fallback: location or geocoded city
    if (theater.location === 'newYork') return true;
    if ((theater.geocodedCity || '').toLowerCase() === 'new york') return true;

    return false;
  });
}

/**
 * Extract date string from Parse Date object or plain string
 */
function parseDate(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (val.iso) return val.iso; // Parse Date: { __type: "Date", iso: "..." }
  return '';
}

/**
 * Normalize title for comparison
 */
function normalize(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/g, '')
    .trim();
}

/**
 * Match Mezzanine productions to our shows.json entries
 *
 * Strategy: For each of our shows, find ALL matching Mezzanine productions.
 * When multiple productions match the same show (e.g., "Angels in America:
 * Millennium Approaches" + "Perestroika"), merge them by averaging ratings
 * weighted by review count.
 */
function matchProductions(productions, shows) {
  const matches = [];

  for (const show of shows) {
    const title = show.title;
    const openYear = parseInt((show.openingDate || '').substring(0, 4));
    const normTitle = normalize(title);
    const overrideName = MEZZANINE_OVERRIDES[show.id];
    const normOverride = overrideName ? normalize(overrideName) : null;

    // Collect ALL matching productions (not just best)
    const allMatches = [];

    for (const p of productions) {
      const mName = normalize(p.show?.name || p.showName || '');
      const mYear = parseInt(parseDate(p.opened || p.firstPreview).substring(0, 4));
      let confidence = 'none';

      // Strategy 0: Manual override match
      if (normOverride && mName === normOverride) {
        confidence = 'high';
      }

      // Strategy 1: Normalized exact match
      if (confidence === 'none' && mName === normTitle) {
        confidence = (openYear && mYear && Math.abs(mYear - openYear) <= 1) ? 'high' : 'medium';
      }

      // Strategy 2: Prefix matching (handles subtitles like "Angels in America: Perestroika")
      // Guards: shorter title must be >= 8 chars, at word boundary, and either >= 50% of longer
      // or have 2+ words. This prevents "elf" matching "twelfth", "art" matching "tartuffe", etc.
      if (confidence === 'none') {
        const shorter = mName.length <= normTitle.length ? mName : normTitle;
        const longer = mName.length <= normTitle.length ? normTitle : mName;
        if (shorter.length >= 8 && longer.startsWith(shorter + ' ')) {
          const ratio = shorter.length / longer.length;
          const wordCount = shorter.split(' ').length;
          if (ratio >= 0.5 || wordCount >= 2) {
            confidence = (openYear && mYear && Math.abs(mYear - openYear) <= 1) ? 'high' : 'low';
          }
        }
      }

      if (confidence !== 'none' && p.ratingsCount >= 5) {
        const yearVerified = openYear && mYear && Math.abs(mYear - openYear) <= 1;
        // Require year verification for non-high confidence
        if (!yearVerified && confidence !== 'high') continue;
        allMatches.push({ production: p, confidence, yearVerified });
      }
    }

    if (allMatches.length === 0) continue;

    // Merge multiple matching productions (weighted average by review count)
    if (allMatches.length > 1) {
      const names = allMatches.map(m => m.production.show?.name || m.production.showName).join(' + ');
      const totalRatings = allMatches.reduce((sum, m) => sum + m.production.ratingsCount, 0);
      const weightedAvg = allMatches.reduce((sum, m) =>
        sum + m.production.averageRating * m.production.ratingsCount, 0) / totalRatings;
      const bestConf = allMatches.some(m => m.confidence === 'high') ? 'high' : 'medium';
      const anyYearVerified = allMatches.some(m => m.yearVerified);

      if (verbose) {
        console.log(`  Merged ${allMatches.length} productions for ${title}: ${names} (${totalRatings} total ratings)`);
      }

      matches.push({
        showId: show.id,
        title: show.title,
        mezzName: names,
        theater: allMatches[0].production.theater?.name || 'Unknown',
        score: Math.round((weightedAvg / 5) * 100),
        starRating: Math.round(weightedAvg * 10) / 10,
        ratingsCount: totalRatings,
        yearVerified: anyYearVerified,
        confidence: bestConf,
        mergedFrom: allMatches.length
      });
    } else {
      const m = allMatches[0];
      const p = m.production;
      matches.push({
        showId: show.id,
        title: show.title,
        mezzName: p.show?.name || p.showName,
        theater: p.theater?.name || p.theaterName || 'Unknown',
        score: Math.round((p.averageRating / 5) * 100),
        starRating: Math.round(p.averageRating * 10) / 10,
        ratingsCount: p.ratingsCount,
        yearVerified: m.yearVerified,
        confidence: m.confidence
      });
    }
  }

  return matches;
}

/**
 * Calculate combined audience buzz score (same as recalculate-audience-buzz.js)
 */
function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore?.score != null;
  const hasMezzanine = sources.mezzanine?.score != null;
  const hasReddit = sources.reddit?.score != null;

  if (!hasShowScore && !hasMezzanine && !hasReddit) {
    return { score: null, weights: null };
  }

  // When only Reddit exists, give it 100% weight (not 20%)
  if (!hasShowScore && !hasMezzanine && hasReddit) {
    return {
      score: Math.round(sources.reddit.score),
      weights: { showScore: 0, mezzanine: 0, reddit: 100 }
    };
  }

  const redditWeight = hasReddit ? 0.20 : 0;
  const remainingWeight = 1 - redditWeight;

  let showScoreWeight = 0;
  let mezzanineWeight = 0;

  if (hasShowScore && hasMezzanine) {
    const ssCount = sources.showScore.reviewCount || 1;
    const mezzCount = sources.mezzanine.reviewCount || 1;
    const totalCount = ssCount + mezzCount;
    showScoreWeight = (ssCount / totalCount) * remainingWeight;
    mezzanineWeight = (mezzCount / totalCount) * remainingWeight;
  } else if (hasShowScore) {
    showScoreWeight = remainingWeight;
  } else if (hasMezzanine) {
    mezzanineWeight = remainingWeight;
  }

  let weightedSum = 0;
  if (hasShowScore) weightedSum += sources.showScore.score * showScoreWeight;
  if (hasMezzanine) weightedSum += sources.mezzanine.score * mezzanineWeight;
  if (hasReddit) weightedSum += sources.reddit.score * redditWeight;

  return {
    score: Math.round(weightedSum),
    weights: {
      showScore: Math.round(showScoreWeight * 100),
      mezzanine: Math.round(mezzanineWeight * 100),
      reddit: Math.round(redditWeight * 100),
    }
  };
}

/**
 * Update audience-buzz.json entry for a show
 */
function updateAudienceBuzz(match) {
  const showId = match.showId;

  // Initialize show entry if it doesn't exist
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title: match.title,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
      }
    };
  }

  const show = audienceBuzz.shows[showId];
  if (!show.sources) show.sources = {};

  // Update Mezzanine data
  show.sources.mezzanine = {
    score: match.score,
    reviewCount: match.ratingsCount,
    starRating: match.starRating
  };

  // Recalculate combined score
  const { score, weights } = calculateCombinedScore(show.sources);

  if (score !== null) {
    show.combinedScore = score;

    if (score >= 88) show.designation = 'Loving';
    else if (score >= 78) show.designation = 'Liking';
    else if (score >= 68) show.designation = 'Shrugging';
    else show.designation = 'Loathing';

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Mezzanine Audience Data Scraper');
  console.log('================================\n');

  if (!APP_ID) {
    console.error('Error: MEZZANINE_APP_ID environment variable must be set');
    process.exit(1);
  }
  if (!SESSION_TOKEN) {
    console.error('Error: MEZZANINE_SESSION_TOKEN environment variable must be set');
    console.error('To get a fresh token, intercept Mezzanine iOS app traffic via mitmproxy.');
    process.exit(1);
  }

  // 1. Fetch all productions from Mezzanine
  console.log('Fetching all productions from Mezzanine API...');
  let allProductions;
  try {
    allProductions = await fetchAllProductions();
  } catch (e) {
    console.error('Failed to fetch productions:', e.message);
    process.exit(1);
  }
  console.log(`Fetched ${allProductions.length} productions with ratings`);

  // 2. Filter to NYC/Broadway productions
  const nycProductions = filterNYCProductions(allProductions);
  console.log(`Filtered to ${nycProductions.length} NYC/Broadway productions\n`);

  // 3. Get shows to process
  let shows = showsData.shows;

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  if (showsArg) {
    if (showsArg === 'missing') {
      shows = shows.filter(s => {
        const b = (audienceBuzz.shows || {})[s.id];
        return !b || !b.sources || !b.sources.mezzanine;
      });
      console.log(`Found ${shows.length} shows missing Mezzanine data`);
    } else {
      const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
      shows = showsData.shows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
      if (shows.length === 0) {
        console.error(`No shows found matching: ${showsArg}`);
        process.exit(1);
      }
      console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
    }
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  console.log(`Matching ${shows.length} shows against ${nycProductions.length} Mezzanine productions...\n`);

  // 4. Match productions to shows
  const matches = matchProductions(nycProductions, shows);

  console.log(`Found ${matches.length} matches\n`);

  // 5. Update audience-buzz.json
  let added = 0, updated = 0;

  for (const match of matches) {
    const existing = audienceBuzz.shows[match.showId]?.sources?.mezzanine;
    const isNew = !existing || !existing.score;

    if (dryRun) {
      const tag = isNew ? 'NEW' : 'UPDATE';
      console.log(`[${tag}] ${match.title} → ${match.mezzName} @ ${match.theater}: ${match.starRating}/5 (${match.ratingsCount} ratings) [${match.confidence}]`);
      continue;
    }

    updateAudienceBuzz(match);

    if (isNew) {
      added++;
      console.log(`+ ${match.title}: ${match.starRating}/5 (${match.ratingsCount} ratings)`);
    } else {
      // Only log if score changed
      if (existing.score !== match.score || existing.reviewCount !== match.ratingsCount) {
        updated++;
        console.log(`~ ${match.title}: ${existing.starRating}/5 → ${match.starRating}/5 (${existing.reviewCount} → ${match.ratingsCount} ratings)`);
      }
    }
  }

  if (!dryRun) {
    // Save
    audienceBuzz._meta = audienceBuzz._meta || {};
    audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
    audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
    audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20%, Show Score & Mezzanine split remaining 80% by sample size';

    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));

    console.log(`\nResults:`);
    console.log(`  Added: ${added} new shows`);
    console.log(`  Updated: ${updated} existing shows`);
    console.log(`  Total shows in audience-buzz.json: ${Object.keys(audienceBuzz.shows).length}`);
    console.log(`  Saved to audience-buzz.json`);
  } else {
    console.log(`\n[DRY RUN] Would add ${matches.filter(m => !audienceBuzz.shows[m.showId]?.sources?.mezzanine?.score).length}, update ${matches.filter(m => audienceBuzz.shows[m.showId]?.sources?.mezzanine?.score).length}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
