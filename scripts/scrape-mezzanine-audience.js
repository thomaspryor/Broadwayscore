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
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isLondonMarket } = require('./lib/venue-classification');

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
  'cabaret-at-the-kit-kat-club-west-end-2021': 'Cabaret',
  'harry-potter-and-the-cursed-child-both-parts-west-end-2021': 'Harry Potter and the Cursed Child',
  'six-the-musical-west-end-2021': 'Six',
  // OB shows where our title appends "the Musical" but Mezzanine uses short title
  'heathers-the-musical-off-broadway-2025': 'Heathers',
  'little-women-the-musical-off-broadway-2026': 'Little Women',
  'the-little-mermaid-the-musical-off-broadway-2026': 'The Little Mermaid',
  'friends-the-musical-parody-off-broadway-2022': 'Friends! The Musical Parody',
  // Subtitle differences vs Mezzanine's short title
  'beaches-2026': 'Beaches',
  // & vs "and" (normalize() strips & to nothing, leaving "drunk romeo juliet")
  'drunk-romeo-and-juliet-off-broadway-2025': 'Drunk Romeo and Juliet',
};

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

// Load data
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showMapById = {};
for (const s of showsData.shows) showMapById[s.id] = s;
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
 * Filter to NYC-area productions (Broadway + Off-Broadway)
 * Uses Mezzanine's own theater metadata: isBroadway, location, geocodedCity
 * Includes Brooklyn venues (many OB theaters are in Brooklyn/Bushwick)
 */
function filterNYCProductions(productions) {
  return productions.filter(p => {
    const theater = p.theater;
    if (!theater) return false;

    // Primary: Mezzanine's own Broadway flag
    if (theater.isBroadway === true) return true;

    const loc = (theater.location || '').toLowerCase();
    const city = (theater.geocodedCity || '').toLowerCase();

    // Location field variants: "newYork", "NYC", "New York City", "Brooklyn, NY", etc.
    if (loc === 'newyork' || loc === 'nyc') return true;
    if (loc.includes('new york') || loc.includes('brooklyn') || loc.includes('manhattan')) return true;

    // Geocoded city: "New York", "Brooklyn", "Manhattan"
    if (city === 'new york' || city === 'brooklyn' || city === 'manhattan') return true;

    return false;
  });
}

/**
 * Filter to London/West End productions
 * Uses Mezzanine's theater metadata: location, geocodedCity
 */
function filterLondonProductions(productions) {
  return productions.filter(p => {
    const theater = p.theater;
    if (!theater) return false;

    const loc = (theater.location || '').toLowerCase();
    const city = (theater.geocodedCity || '').toLowerCase();

    if (loc === 'london') return true;
    if (city === 'london') return true;

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
    .replace(/['\u2018\u2019\u201C\u201D!?:,.;\-\u2013\u2014\u2026&+()/*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/g, '')
    .trim();
}

/**
 * Deduplicate matches: when the same Mezzanine production is claimed by
 * multiple of our shows (e.g., OB 2024 and Broadway 2026 transfers), assign
 * it to the best match and remove it from the others.
 *
 * Priority: year-verified > currently running/previews > most recent opening.
 */
function deduplicateMatches(matches) {
  // Build a map: Mezzanine prodId → list of match indices that claim it
  const prodClaimants = new Map();
  for (let i = 0; i < matches.length; i++) {
    for (const pid of matches[i].prodIds) {
      if (!prodClaimants.has(pid)) prodClaimants.set(pid, []);
      prodClaimants.get(pid).push(i);
    }
  }

  // Find conflicts: a Mezzanine production claimed by >1 of our shows
  const indicesToRemove = new Set();
  for (const [pid, claimants] of prodClaimants) {
    if (claimants.length <= 1) continue;

    // Score each claimant to pick the best
    const scored = claimants.map(idx => {
      const m = matches[idx];
      let priority = 0;
      if (m.yearVerified) priority += 100;
      if (m.showStatus === 'running' || m.showStatus === 'previews') priority += 50;
      // Tiebreak: most recent opening year
      priority += (m.showOpenYear || 0) / 100;
      return { idx, priority, showId: m.showId };
    }).sort((a, b) => b.priority - a.priority);

    const winner = scored[0];
    const losers = scored.slice(1);

    console.log(`  ⚠ Mezzanine dedup: production "${pid}" claimed by ${scored.map(s => s.showId).join(', ')} → assigned to ${winner.showId}`);

    for (const loser of losers) {
      // If the loser match only had this one prodId, remove it entirely
      const loserMatch = matches[loser.idx];
      loserMatch.prodIds = loserMatch.prodIds.filter(p => p !== pid);
      if (loserMatch.prodIds.length === 0) {
        indicesToRemove.add(loser.idx);
      }
    }
  }

  if (indicesToRemove.size > 0) {
    return matches.filter((_, i) => !indicesToRemove.has(i));
  }
  return matches;
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

  const today = new Date().toISOString().split('T')[0];

  // Build index of sibling shows (same normalized title, different IDs).
  // When a Mezzanine production matches a title that has siblings, we assign
  // it to the show with the closest opening year — not merge all of them.
  const siblingsByNormTitle = new Map();
  for (const s of shows) {
    const norm = normalize(s.title);
    if (!siblingsByNormTitle.has(norm)) siblingsByNormTitle.set(norm, []);
    siblingsByNormTitle.get(norm).push(s);
  }

  for (const show of shows) {
    // Skip shows whose previews haven't started yet — no real audience data possible
    const previewDate = show.previewsStartDate || show.openingDate;
    if (previewDate && previewDate > today) {
      if (verbose) console.log(`  SKIP ${show.id}: previews haven't started yet (${previewDate})`);
      continue;
    }

    const title = show.title;
    const openYear = parseInt((show.openingDate || '').substring(0, 4));
    const normTitle = normalize(title);
    const overrideName = MEZZANINE_OVERRIDES[show.id];
    const normOverride = overrideName ? normalize(overrideName) : null;
    const siblings = siblingsByNormTitle.get(normTitle) || [];
    const hasSiblings = siblings.length > 1;

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
      // Exact title match is always high confidence — year mismatch is common for
      // long-running shows (WE Phantom 1986 vs our 2021, Mousetrap 1952, etc.)
      if (confidence === 'none' && mName === normTitle) {
        confidence = 'high';
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

      if (confidence !== 'none' && p.ratingsCount >= 1) {
        const yearVerified = openYear && mYear && Math.abs(mYear - openYear) <= 1;
        // Require year verification for non-high confidence
        if (!yearVerified && confidence !== 'high') continue;

        // When multiple of our shows share the same title (transfers, revivals),
        // assign each Mezzanine production to the show with the closest year.
        // This prevents merging OB + Broadway productions together.
        if (hasSiblings && mYear && openYear) {
          const myGap = Math.abs(mYear - openYear);
          const closerSibling = siblings.find(s => {
            if (s.id === show.id) return false;
            const sYear = parseInt((s.openingDate || '').substring(0, 4));
            return sYear && Math.abs(mYear - sYear) < myGap;
          });
          if (closerSibling) {
            if (verbose) console.log(`  SKIP prod ${p.objectId || mName} (year ${mYear}) for ${show.id} — closer to ${closerSibling.id}`);
            continue;
          }
        }

        allMatches.push({ production: p, confidence, yearVerified, prodId: p.objectId || `${mName}-${mYear}` });
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
        showStatus: show.status,
        showOpenYear: openYear,
        mezzName: names,
        theater: allMatches[0].production.theater?.name || 'Unknown',
        score: Math.round((weightedAvg / 5) * 100),
        starRating: Math.round(weightedAvg * 10) / 10,
        ratingsCount: totalRatings,
        yearVerified: anyYearVerified,
        confidence: bestConf,
        mergedFrom: allMatches.length,
        prodIds: allMatches.map(m => m.prodId),
      });
    } else {
      const m = allMatches[0];
      const p = m.production;
      matches.push({
        showId: show.id,
        title: show.title,
        showStatus: show.status,
        showOpenYear: openYear,
        mezzName: p.show?.name || p.showName,
        theater: p.theater?.name || p.theaterName || 'Unknown',
        score: Math.round((p.averageRating / 5) * 100),
        starRating: Math.round(p.averageRating * 10) / 10,
        ratingsCount: p.ratingsCount,
        yearVerified: m.yearVerified,
        confidence: m.confidence,
        prodIds: [m.prodId],
      });
    }
  }

  return deduplicateMatches(matches);
}

// calculateCombinedScore imported from ./lib/audience-weighting.js

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
        theatr: null,
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
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score, weights } = calculateCombinedScore(show.sources, showInfo);

  if (score !== null) {
    show.combinedScore = score;

    show.designation = getDesignation(score);

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%`);
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
  if (allProductions.length === 0) {
    console.error('⚠️  CRITICAL: Mezzanine API returned 0 productions — session token may have expired');
    process.exit(1);
  }

  // 2. Filter productions by market
  const nycProductions = filterNYCProductions(allProductions);
  const londonProductions = filterLondonProductions(allProductions);
  console.log(`Filtered to ${nycProductions.length} NYC/Broadway + ${londonProductions.length} London/West End productions\n`);
  if (allProductions.length > 50 && nycProductions.length === 0) {
    console.error('⚠️  WARNING: 0 NYC productions from ' + allProductions.length + ' total — location filter may be broken');
  }

  // 3. Get shows to process (all categories — match each against its market's pool)
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

  // Split shows by market for correct pool matching
  const nycShows = shows.filter(s => !isLondonMarket(s.category));
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Matching ${nycShows.length} NYC shows + ${weShows.length} WE shows against their market pools...\n`);

  // 4. Match productions to shows (each market against its own pool)
  const nycMatches = matchProductions(nycProductions, nycShows);
  const weMatches = matchProductions(londonProductions, weShows);
  const matches = [...nycMatches, ...weMatches];
  if (weMatches.length > 0) {
    console.log(`  West End matches: ${weMatches.length}`);
  }

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
    audienceBuzz._meta.lastUpdated = new Date().toISOString();
    if (!audienceBuzz._meta.sources) audienceBuzz._meta.sources = [];
    if (!audienceBuzz._meta.sources.includes('Mezzanine')) {
      audienceBuzz._meta.sources.push('Mezzanine');
    }

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
