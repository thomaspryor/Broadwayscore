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
const { normalizeTitle, titleTokens, jaccard, foldDiacritics } = require('./lib/title-match');
const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');

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
  // The "regional" pool is everything that isn't NYC or London, so the 2024
  // UK premiere at The Lowry (Salford) lands in the same pool as our Chicago
  // Shakespeare tryout and a bare-title match merged both (157 UK + 122 US
  // ratings). Venue pin restricts to the Chicago run.
  '42-balloons-regional-2025': { name: '42 Balloons', venue: 'Chicago Shakespeare' },
  // "Cabaret" is one of the most-revived musicals in the world (100+ Mezzanine
  // productions with ratings, from Studio 54 to a high school gym). A bare
  // override was pulling in stray London one-off productions alongside our
  // real Playhouse Theatre run (found via /what-else audit of card #313 —
  // same bug class as the Romeo and Juliet fix below). Venue pin isolates ours.
  'cabaret-at-the-kit-kat-club-west-end-2021': { name: 'Cabaret', venue: 'Playhouse' },
  // Bare "Harry Potter and the Cursed Child" also matches the separate
  // Broadway production (harry-potter-2021, Lyric Theatre) — a bare override
  // would merge both markets' Mezzanine ratings into this West End show.
  // Venue pin restricts to the Palace Theatre run (found via BRO-86 collision
  // auditor sweep — same bug class as card #313).
  'harry-potter-and-the-cursed-child-both-parts-west-end-2021': { name: 'Harry Potter and the Cursed Child', venue: 'Palace' },
  // Bare "Six" also matches the separate Broadway production (six-2021, Lena
  // Horne Theatre) — venue pin restricts to the Vaudeville Theatre run.
  'six-the-musical-west-end-2021': { name: 'Six', venue: 'Vaudeville' },
  // OB shows where our title appends "the Musical" but Mezzanine uses short title.
  // Bare "Heathers" also matches the separate West End production
  // (heathers-the-musical-off-west-end-2026) — venue pin restricts to the
  // New World Stages run.
  'heathers-the-musical-off-broadway-2025': { name: 'Heathers', venue: 'New World Stages' },
  // "Little Women" bare override was merging our small off-Broadway revival
  // with the unrelated 2005 Virginia Theatre Broadway production (30 ratings,
  // wrong show). Venue pin restricts to our 92NY run — currently 0 Mezzanine
  // matches for that venue, which is correct (no data beats wrong data).
  'little-women-the-musical-off-broadway-2026': { name: 'Little Women', venue: '92NY' },
  // Same bug: bare "The Little Mermaid" was merging in the 2008 Lunt-Fontanne
  // Broadway production (241 ratings) into our small off-Broadway revival.
  'the-little-mermaid-the-musical-off-broadway-2026': { name: 'The Little Mermaid', venue: 'Players Theatre' },
  'friends-the-musical-parody-off-broadway-2022': 'Friends! The Musical Parody',
  // Subtitle differences vs Mezzanine's short title
  'beaches-2026': 'Beaches',
  // Reordered titles (Mezzanine puts disambiguator in parens, we put it leading)
  'the-tragedy-of-coriolanus-off-broadway-2026': 'Coriolanus',
  // Censored vs uncensored title
  'meat-suit-or-the-stshow-of-motherhood-off-broadway-2026': 'Meat Suit, or the shitshow of motherhood',
  // We embed venue in title; Mezzanine uses bare title. A bare override was also
  // merging in an unrelated "The Fever" (Wallace Shawn's solo play) run at La
  // Mama. Venue pin restricts to our Greenwich House Theater run.
  'the-fever-greenwich-house-theater-off-broadway-2026': { name: 'The Fever', venue: 'Greenwich House' },
  // Short title (<8 chars) where Mezzanine has parenthesized disambiguator —
  // prefix-match guard requires shorter≥8 chars; explicit override needed.
  'trash-off-broadway-2026': 'Trash (Comedy, Caverly/Morrill)',
  // Our title carries a concert-series prefix ("Encores!") that Mezzanine omits,
  // AND the bare title "La Cage aux Folles" has many NYC productions (Marquis
  // 2010, Longacre 1983, Palace) that Mezzanine can't separate by year (its
  // Production records carry no opening-date field — mYear is always NaN). A
  // name-only override would merge all of them. The {name, venue} form pins the
  // match to a single venue so only the City Center Encores run is attached.
  'encores-la-cage-aux-folles-off-broadway-2026': { name: 'La Cage aux Folles', venue: 'City Center' },
  // We use "+" as a stylized separator; Mezzanine spells out "and". normalizeTitle
  // only strips "and" from titleTokens (jaccard), not from the exact-match string,
  // so Strategy 1 never fired even though the coverage audit's jaccard=1 masked it.
  // "Romeo and Juliet" is one of the most-produced titles in the English language —
  // a bare override would merge in unrelated NYC productions (2013 Richard Rodgers
  // revival, 2023 Classic Stage Co., 2026 Shakespeare in the Park, a Columbia
  // University student show). Venue pin restricts to our Circle in the Square run.
  'romeo-juliet-2024': { name: 'Romeo and Juliet', venue: 'Circle in the Square' },
  // Mezzanine's bare "Hot Mess" is a low-confidence prefix match against our
  // "Hot Mess: A New Musical" (normalizes to "hot mess a new") because the show
  // has no openingDate yet (only previewsStartDate), so year-verification can't
  // promote it past 'low' confidence and it gets dropped. Covers both the
  // Southwark Playhouse Elephant tryout and The Other Palace transfer.
  'hot-mess-a-new-musical-off-west-end-2026': 'Hot Mess',
};

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');

// Load data (skipped when required as a module — tests provide their own data)
let showsData, showMapById, audienceBuzz;
if (require.main === module) {
  showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  showMapById = {};
  for (const s of showsData.shows) showMapById[s.id] = s;
  audienceBuzz = loadAudienceBuzz();

  // Validate override show IDs exist (catches drift when shows.json renames an
  // ID and silently leaves the override pointing at nothing — Claude review #4).
  for (const overrideId of Object.keys(MEZZANINE_OVERRIDES)) {
    if (!showMapById[overrideId]) {
      console.warn(`⚠ MEZZANINE_OVERRIDES key "${overrideId}" is not in shows.json — override is dead config and should be removed or updated.`);
    }
  }
}

// Transient network errors worth retrying. Auth failures (401/403) and parse
// errors are NOT transient — they re-throw immediately.
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE']);
const TRANSIENT_MESSAGES = /socket hang up|read ECONNRESET|connect ETIMEDOUT|request timeout/i;

class AuthError extends Error {
  constructor(statusCode) {
    super(`Authentication failed (${statusCode}). Session token may have expired. Re-intercept via mitmproxy to get a fresh token.`);
    this.statusCode = statusCode;
    this.isAuth = true;
    this.exitCode = 2; // distinct from generic failure
  }
}

function isTransient(err) {
  if (!err || err.isAuth) return false;
  if (err.code && TRANSIENT_NET_CODES.has(err.code)) return true;
  if (err.message && TRANSIENT_MESSAGES.test(err.message)) return true;
  return false;
}

function queryParseOnce(className, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: '/parse/classes/' + className,
      method: 'POST',
      timeout: 60000,
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
          reject(new AuthError(res.statusCode));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Query Parse Server API with retry-on-transient-error.
 *
 * Retries up to 3 times (4 attempts total) on ECONNRESET / ETIMEDOUT /
 * socket hang up / request timeout with exponential backoff (1s, 3s, 9s).
 * Auth failures (401/403) and Parse-server errors fail immediately.
 */
async function queryParse(className, body) {
  const MAX_ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await queryParseOnce(className, body);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === MAX_ATTEMPTS) throw e;
      const delayMs = Math.pow(3, attempt - 1) * 1000;
      console.warn(`  ⚠ Transient API error (${e.code || e.message}); retrying in ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
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

// normalize() lives in scripts/lib/title-match.js (shared, unit-tested).
const normalize = normalizeTitle;

/**
 * Normalize a venue string for identity comparison: fold diacritics, drop a
 * leading "The", strip the generic "theatre"/"theater" word, collapse
 * punctuation to spaces.
 *
 * Deliberately does NOT use title-match.js's canonicalVenue() — its
 * unknown-venue fallback keys on the FIRST WORD ONLY, which collapses real,
 * distinct theaters that share one ("Prince Edward Theatre" and "Prince of
 * Wales Theatre" both → "prince"; "Apollo Theatre" and "Apollo Victoria
 * Theatre" both → "apollo"). That fallback exists for a different job
 * (shared-stage dedup) where those collisions don't come up; reusing it here
 * would silently reintroduce the exact contamination class this fix is for
 * (Codex adversarial review, BRO-975).
 */
function normalizeVenueForMatch(v) {
  return foldDiacritics(v || '')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/\btheatre\b|\btheater\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when two venue strings identify the same physical theater. Requires
 * exact match after normalization, OR one to be a distinguishing PREFIX of
 * the other (handles a descriptive suffix like "New York City Center" vs
 * "New York City Center - Mainstage") — but only once the shared prefix is
 * long/specific enough that a short, generic word can't accidentally prefix
 * an unrelated venue that happens to start the same way ("Lyric" must not
 * prefix-match "Lyric Hammersmith"). Threshold matches the existing
 * short-title-match guard used elsewhere in this file (Strategy 2, `>= 8`).
 */
function venuesMatch(a, b) {
  const na = normalizeVenueForMatch(a);
  const nb = normalizeVenueForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 8 && longer.startsWith(shorter + ' ');
}

/**
 * BRO-975: for a one-off revival, Mezzanine can hold Production records for
 * SEVERAL distinct physical stagings of the same title (e.g. Romeo and
 * Juliet has run at a dozen different London theaters over the decades). The
 * exact-title-match strategy (confidence='high') treats all of them as the
 * same show and merge-averages their ratings together, so an old archival
 * production silently drags the current revival's score around.
 *
 * This only matters when a show has MULTIPLE candidate Production matches —
 * a single match is left untouched (long-runners like Mamma Mia rely on the
 * unconditional year-verification bypass: Mezzanine's theater name for a
 * decades-old continuous run doesn't always track a mid-run venue rename, and
 * we have no live data in this environment to safely tighten that path).
 *
 * Selection: our shows.json `venue` field is the ground truth for which
 * physical theater the CURRENT production plays. Any candidate whose theater
 * matches it represents that production; every candidate at a DIFFERENT
 * theater is a different production of the same title and is dropped,
 * regardless of how close its year is (an OB-to-transfer within one show.json
 * entry that changed venues is the accepted tradeoff here — Option A from the
 * ticket, "merge only with same-venue productions").
 *
 * Only when NO candidate's venue matches ours (missing/unrecognized venue
 * data) do we fall back to the existing year-verification rule used
 * elsewhere in this file (opened within ±1 year of our openingDate) — a
 * production 2+ years off is exactly the kind of historical noise this
 * bug is about (Avenue Q's closest historical run is 2 years out; picking
 * it "because it's closest" would just swap one wrong answer for another).
 * Within that fallback window, candidates with DIFFERENT known theaters are
 * still different productions — being close in time isn't enough on its own
 * (Codex adversarial review, BRO-975) — so we anchor on the year closest to
 * ours and only keep others that share ITS venue, or have no venue info to
 * contradict it. If nothing clears the year bar at all, we drop every
 * candidate — no data beats wrong data.
 */
function selectCurrentProductionMatches(allMatches, openYear, showVenue) {
  if (allMatches.length <= 1) return allMatches;

  const withInfo = allMatches.map(m => {
    const y = parseInt(parseDate(m.production.opened || m.production.firstPreview).slice(0, 4));
    return {
      m,
      y: Number.isFinite(y) ? y : null,
      theater: m.production.theater?.name || m.production.theaterName || null,
    };
  });
  for (const x of withInfo) {
    x.venueMatch = showVenue && x.theater ? venuesMatch(showVenue, x.theater) : false;
  }

  const venueConfirmed = withInfo.filter(x => x.venueMatch);
  if (venueConfirmed.length > 0) {
    return venueConfirmed.map(x => x.m);
  }

  if (!openYear) return [];
  const yearVerified = withInfo.filter(x => x.y !== null && Math.abs(x.y - openYear) <= 1);
  if (yearVerified.length === 0) return [];

  const anchor = yearVerified.reduce((a, b) => (Math.abs(a.y - openYear) <= Math.abs(b.y - openYear) ? a : b));
  return yearVerified.filter(x => {
    if (x === anchor) return true;
    if (!x.theater || !anchor.theater) return true;
    return venuesMatch(x.theater, anchor.theater);
  }).map(x => x.m);
}

/**
 * BRO-975: shows that had Mezzanine data attached by a pre-fix run but whose
 * candidates no longer confirm a current production this run — that stale,
 * possibly-contaminated data must be cleared, not left in place (fixing the
 * matcher alone doesn't retroactively fix already-written audience-buzz.json
 * entries; only a FUTURE valid match would ever overwrite one otherwise).
 *
 * Pure decision function — separated from the I/O (delete + recalculate +
 * save) so it's unit-testable without a live audienceBuzz object.
 */
function findStaleMezzanineShowIds(processedShows, matchedShowIds, audienceBuzzShows) {
  return processedShows
    .filter(s => audienceBuzzShows[s.id]?.sources?.mezzanine && !matchedShowIds.has(s.id))
    .map(s => s.id);
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
    const override = MEZZANINE_OVERRIDES[show.id];
    const overrideName = typeof override === 'string' ? override : (override && override.name);
    const overrideVenue = (override && typeof override === 'object') ? override.venue : null;
    const normOverride = overrideName ? normalize(overrideName) : null;
    const siblings = siblingsByNormTitle.get(normTitle) || [];
    const hasSiblings = siblings.length > 1;

    // Collect ALL matching productions (not just best)
    let allMatches = [];

    for (const p of productions) {
      const mName = normalize(p.show?.name || p.showName || '');
      const mYear = parseInt(parseDate(p.opened || p.firstPreview).substring(0, 4));
      let confidence = 'none';

      // Strategy 0: Manual override match. When the override pins a venue,
      // require the production's theater name to contain it — this is how a
      // bare-title override (e.g. "La Cage aux Folles") selects ONE of several
      // same-named NYC productions that Mezzanine can't separate by year.
      if (normOverride && mName === normOverride) {
        if (overrideVenue) {
          const tName = (p.theater?.name || '').toLowerCase();
          if (tName.includes(overrideVenue.toLowerCase())) confidence = 'high';
        } else {
          confidence = 'high';
        }
      }

      // Strategy 1: Normalized exact match
      // Exact title match is always high confidence — year mismatch is common for
      // long-running shows (WE Phantom 1986 vs our 2021, Mousetrap 1952, etc.)
      // Skip when this show has a venue-pinned override: that pin exists
      // specifically because bare-title matching is unsafe (a common title
      // colliding with unrelated productions — e.g. "Little Women" matching
      // the 2005 Virginia Theatre Broadway run instead of our small revival).
      // Without this guard Strategy 1 fires unconditionally and bypasses the
      // pin entirely, since it runs independent of MEZZANINE_OVERRIDES.
      if (confidence === 'none' && !overrideVenue && mName === normTitle) {
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
          // Sibling-aware year gate: when multiple of our shows share a title,
          // the exact-title-match high-confidence path bypasses year checking
          // and silently merges unrelated productions (RSC tours, regional)
          // into the most-recent revival. Require year-verification when
          // siblings exist so productions that don't match ANY of our entries
          // get dropped, not attached to the closest revival.
          // See feedback_dual_repo_data_files.md / audience-buzz triage 2026-05-24.
          if (!yearVerified) {
            if (verbose) console.log(`  SKIP prod ${p.objectId || mName} (year ${mYear}) for ${show.id} — sibling-aware year gate (no sibling within ±1)`);
            continue;
          }
        }

        allMatches.push({ production: p, confidence, yearVerified, prodId: p.objectId || `${mName}-${mYear}` });
      }
    }

    if (allMatches.length === 0) continue;

    // BRO-975: narrow down to the productions that actually represent the
    // CURRENT run before merging — see selectCurrentProductionMatches().
    const currentMatches = selectCurrentProductionMatches(allMatches, openYear, show.venue);
    if (currentMatches.length === 0) {
      if (verbose) console.log(`  SKIP ${show.id}: ${allMatches.length} title match(es) found but none confirmed as the current production (venue mismatch)`);
      continue;
    }
    allMatches = currentMatches;

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

  // Update Mezzanine data. prodIds persisted so wrong-merge regressions can be
  // diagnosed without git archaeology (Codex review: previously rollback
  // depended on external git history).
  show.sources.mezzanine = {
    score: match.score,
    reviewCount: match.ratingsCount,
    starRating: match.starRating,
    prodIds: match.prodIds || []
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
    // Exit code 2 = auth failure (token rotation needed). Exit code 1 = anything
    // else (transient network, server error). The workflow alert step branches
    // on this so we stop emailing "rotate the token" for ECONNRESETs.
    process.exit(e && e.isAuth ? 2 : 1);
  }
  console.log(`Fetched ${allProductions.length} productions with ratings`);
  if (allProductions.length === 0) {
    console.error('⚠️  CRITICAL: Mezzanine API returned 0 productions — session token may have expired');
    process.exit(2);
  }

  // 2. Filter productions by market
  const nycProductions = filterNYCProductions(allProductions);
  const londonProductions = filterLondonProductions(allProductions);
  // Regional (non-NYC US) pool: everything Mezzanine has that isn't NYC or London.
  // Mezzanine is global (e.g. A.R.T. Cambridge), so regional shows match here.
  const _nycSet = new Set(nycProductions);
  const _londonSet = new Set(londonProductions);
  const regionalProductions = allProductions.filter(p => !_nycSet.has(p) && !_londonSet.has(p));
  console.log(`Filtered to ${nycProductions.length} NYC/Broadway + ${londonProductions.length} London/West End + ${regionalProductions.length} other (regional) productions\n`);
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
  const nycShows = shows.filter(s => !isLondonMarket(s.category) && s.category !== 'regional');
  const weShows = shows.filter(s => isLondonMarket(s.category));
  const regionalShows = shows.filter(s => s.category === 'regional');
  console.log(`Matching ${nycShows.length} NYC shows + ${weShows.length} WE shows + ${regionalShows.length} regional shows against their market pools...\n`);

  // 4. Match productions to shows (each market against its own pool)
  const nycMatches = matchProductions(nycProductions, nycShows);
  const weMatches = matchProductions(londonProductions, weShows);
  const regionalMatches = matchProductions(regionalProductions, regionalShows);
  const matches = [...nycMatches, ...weMatches, ...regionalMatches];
  if (weMatches.length > 0) {
    console.log(`  West End matches: ${weMatches.length}`);
  }
  if (regionalMatches.length > 0) {
    console.log(`  Regional matches: ${regionalMatches.length}`);
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

  // BRO-975: a show that HAD Mezzanine data from a previous (pre-fix) run but
  // produces zero matches this run — because selectCurrentProductionMatches()
  // could no longer confirm any candidate as the current production — must
  // have that stale data cleared, not left in place. Otherwise fixing the
  // matcher alone doesn't fix already-contaminated shows like Avenue Q; only
  // a FUTURE valid match would ever overwrite it (Codex adversarial review).
  const processedShows = [...nycShows, ...weShows, ...regionalShows];
  const matchedShowIds = new Set(matches.map(m => m.showId));
  const staleIds = new Set(findStaleMezzanineShowIds(processedShows, matchedShowIds, audienceBuzz.shows));
  let cleared = 0;
  for (const s of processedShows) {
    if (!staleIds.has(s.id)) continue;
    const existingMezz = audienceBuzz.shows[s.id].sources.mezzanine;

    if (dryRun) {
      console.log(`[CLEAR] ${s.title}: stale Mezzanine data (${existingMezz.reviewCount} ratings) no longer confirms the current production`);
      cleared++;
      continue;
    }

    // delete (not null) — a lingering key, even null-valued, still makes
    // src/app/show/[slug]/page.tsx:366 emit a dead "View on Mezzanine" link
    // for a show with confirmed-zero real data.
    delete audienceBuzz.shows[s.id].sources.mezzanine;
    const showInfo = { closingDate: s.closingDate, status: s.status, category: s.category };
    const { score } = calculateCombinedScore(audienceBuzz.shows[s.id].sources, showInfo);
    audienceBuzz.shows[s.id].combinedScore = score;
    audienceBuzz.shows[s.id].designation = score !== null ? getDesignation(score) : null;
    cleared++;
    console.log(`- ${s.title}: cleared stale Mezzanine data (${existingMezz.reviewCount} ratings)`);
  }
  if (cleared > 0) console.log(`Cleared stale Mezzanine data for ${cleared} show(s) that no longer confirm a current production\n`);

  // Coverage audit: surface unmatched Mezzanine productions whose title is
  // SIMILAR to one of our open/recent shows that lacks Mezzanine data.
  // This catches title-drift (normalize gaps, missing MEZZANINE_OVERRIDES).
  // Tight by design: ignores productions of shows we don't track at all
  // (e.g., West End-only runs of Broadway shows).
  if (!showFilter && !showsArg) {
    const matchedProdIds = new Set();
    for (const m of matches) for (const pid of (m.prodIds || [])) matchedProdIds.add(pid);

    // titleTokens() from scripts/lib/title-match.js keeps "play"/"musical" so
    // type-disambiguated titles don't collapse to identical token sets (Claude
    // review #2: dropping them made Redwood (Play) ≡ Redwood (Musical) ≡
    // Redwood and audit would flag the play production as a candidate match
    // for the musical's show entry).
    const tokens = titleTokens;

    // Index shows that lack Mezzanine data and are open/recent
    const today = new Date().toISOString().slice(0, 10);
    const candidateShows = shows.filter(s => {
      if (audienceBuzz.shows[s.id]?.sources?.mezzanine) return false;
      // Only flag for shows that opened (or will soon) — skip ancient closed ones
      const open = s.openingDate || s.previewsStartDate;
      if (open && open < '2015-01-01') return false;
      return true;
    });
    const candidateIndex = candidateShows.map(s => ({
      s, t: tokens(s.title), n: normalize(s.title), year: parseInt((s.openingDate || '').slice(0,4))
    }));

    const flagged = [];
    const RATING_THRESHOLD = 20;
    for (const p of [...nycProductions, ...londonProductions]) {
      if ((p.ratingsCount || 0) < RATING_THRESHOLD) continue;
      const pid = p.objectId || `${normalize(p.show?.name || p.showName || '')}-${(p.opened?.iso || p.firstPreview?.iso || '').slice(0,4)}`;
      if (matchedProdIds.has(pid)) continue;
      const mName = p.show?.name || p.showName || '';
      const mNorm = normalize(mName);
      const mTokens = tokens(mName);
      if (!mTokens.size) continue;
      const mYear = parseInt(parseDate(p.opened || p.firstPreview).slice(0, 4));

      // Find the best fuzzy match among shows missing Mezzanine
      let best = null;
      for (const c of candidateIndex) {
        if (!c.t.size) continue;
        const j = jaccard(mTokens, c.t);
        if (j < 0.6) continue;
        if (mYear && c.year && Math.abs(mYear - c.year) > 2) continue;
        if (!best || j > best.j) best = { showId: c.s.id, showTitle: c.s.title, showYear: c.year, j };
      }
      if (best) flagged.push({
        mezzName: mName,
        theater: p.theater?.name,
        ratingsCount: p.ratingsCount,
        mYear: mYear || null,
        ourShowId: best.showId,
        ourTitle: best.showTitle,
        ourYear: best.showYear || null,
        jaccard: Number(best.j.toFixed(2)),
        objectId: p.objectId
      });
    }
    if (flagged.length > 0) {
      flagged.sort((a, b) => b.ratingsCount - a.ratingsCount);
      console.log(`\n⚠ Coverage audit: ${flagged.length} Mezzanine productions look like they should match an open/recent show but don't.`);
      console.log(`  Likely missing MEZZANINE_OVERRIDES entry, or a normalize gap:`);
      for (const f of flagged.slice(0, 10)) {
        console.log(`    ${f.ratingsCount.toString().padStart(4)} j=${f.jaccard}  ${f.ourTitle} (${f.ourYear || '?'}) [${f.ourShowId}] ↔ ${f.mezzName} (${f.mYear || '?'}) @ ${f.theater}`);
      }
      if (!dryRun) {
        const auditDir = path.join(__dirname, '../data/audit');
        if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(
          path.join(auditDir, 'mezzanine-coverage.json'),
          JSON.stringify({ lastUpdated: new Date().toISOString(), ratingThreshold: RATING_THRESHOLD, jaccardThreshold: 0.6, count: flagged.length, flagged }, null, 2)
        );
        console.log(`  Written to data/audit/mezzanine-coverage.json`);
      }
    }
  }

  if (!dryRun) {
    // Save
    audienceBuzz._meta = audienceBuzz._meta || {};
    if (!audienceBuzz._meta.sources) audienceBuzz._meta.sources = [];
    if (!audienceBuzz._meta.sources.includes('Mezzanine')) {
      audienceBuzz._meta.sources.push('Mezzanine');
    }

    saveAudienceBuzz(audienceBuzz);

    console.log(`\nResults:`);
    console.log(`  Added: ${added} new shows`);
    console.log(`  Updated: ${updated} existing shows`);
    console.log(`  Total shows in audience-buzz.json: ${Object.keys(audienceBuzz.shows).length}`);
    console.log(`  Saved to audience-buzz.json`);
  } else {
    console.log(`\n[DRY RUN] Would add ${matches.filter(m => !audienceBuzz.shows[m.showId]?.sources?.mezzanine?.score).length}, update ${matches.filter(m => audienceBuzz.shows[m.showId]?.sources?.mezzanine?.score).length}`);
  }
}

if (require.main !== module) {
  module.exports = { matchProductions, deduplicateMatches, normalize, MEZZANINE_OVERRIDES, selectCurrentProductionMatches, venuesMatch, findStaleMezzanineShowIds };
} else {
  main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}
