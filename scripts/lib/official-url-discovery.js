'use strict';

/**
 * SERP-based official-website discovery for a show, extracted from
 * enrich-official-urls.js so scripts/ob-discovery-ticket-links.js (BRO-166)
 * can reuse the exact same domain-blocklist + scoring logic instead of
 * re-implementing it. enrich-official-urls.js now requires this module.
 */

const https = require('https');
const http = require('http');
const { serpQuery } = require('./url-discovery');
const { isLondonMarket } = require('./venue-classification');
const { foldDiacritics } = require('./title-match');

// ============================================================================
// Domain blocklist — never treat these as official show sites
// ============================================================================

const BLOCKED_DOMAINS = new Set([
  // Ticket platforms
  'todaytix.com', 'telecharge.com', 'ticketmaster.com', 'broadwaydirect.com',
  'seatgeek.com', 'stubhub.com', 'vividseats.com', 'broadwaybox.com',
  'goldstar.com', 'headout.com', 'rush.app',
  // Theater/review sites
  'playbill.com', 'broadwayworld.com', 'broadway.com', 'ibdb.com',
  'theatermania.com', 'showscore.com', 'whatsonstage.com',
  'broadwayhd.com', 'bwayrush.com', 'nytimes.com', 'variety.com',
  'hollywoodreporter.com', 'vulture.com', 'timeout.com', 'theguardian.com',
  'nypost.com', 'deadline.com', 'ew.com', 'usatoday.com', 'apnews.com',
  'washingtonpost.com', 'wsj.com', 'latimes.com',
  // Reference/social
  'wikipedia.org', 'wikidata.org', 'imdb.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'threads.net',
  // Generic
  'yelp.com', 'tripadvisor.com', 'google.com', 'amazon.com',
  'pinterest.com', 'linkedin.com', 'tumblr.com',
  // Theater listing/guide sites (not show-specific)
  'broadway.org', 'newyorktheatreguide.com', 'theatreaccess.nyc', 'nystagereview.com',
  'newyorktheater.me', 'theatrely.com', 'stagebuddy.com',
  'londontheatre.co.uk', 'thestage.co.uk',
  // Event listing sites
  'donyc.com', 'eventbrite.com', 'dice.fm', 'songkick.com',
  // Licensing/production companies (not individual show sites)
  'concordtheatricals.com', 'mtishows.com', 'samuelfrench.com',
  'dramatists.com', 'tamswitmark.com',
  // Theater/venue sites (not show-specific)
  'shubert.nyc', 'nederlander.com', 'roundabouttheatre.org', 'lct.org',
  'manhattantheatreclub.com', '2st.com', 'nytw.org', 'publictheater.org',
  'signaturetheatre.org', 'mintheatre.org', 'atlantictheater.org',
  'classicstage.org', 'irishrep.org', 'newworldstages.com',
  // City/government/tourism sites
  'cityofwhiteplains.com', 'nyc.gov', 'nyctourism.com',
  // Our own site and other aggregators
  'broadwayscorecard.com', 'exeuntnyc.com', 'stageandcinema.com',
  'ticketnews.com', 'seatplan.com', 'newyorkcitytheatre.com',
  'masterworksbroadway.com', 'filmedlivemusicals.com',
  'broadwayacrossamerica.com', 'broadway.org.uk',
  'londonsbroadwaybuzz.ca',
]);

function httpHead(url) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const proto = urlObj.protocol === 'https:' ? https : http;
      const reqOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
        timeout: 10000,
      };
      const req = proto.request(reqOptions, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(-1));
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.end();
    } catch {
      resolve(-1);
    }
  });
}

function normalizeShowName(name) {
  // Fold diacritics BEFORE stripping non-ASCII, or accented titles shred into
  // fragments that can never match ("Les Misérables" -> "les mis rables"
  // instead of "les miserables") — see task #648.
  return foldDiacritics(name).toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isBlockedDomain(url) {
  const domain = getDomain(url);
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain === blocked || domain.endsWith('.' + blocked)) return true;
  }
  return false;
}

/**
 * Build a market-appropriate SERP query for finding a show's official site.
 */
function buildSearchQuery(show) {
  const cat = show.category || 'broadway';
  const market = isLondonMarket(cat) ? 'west end' : 'broadway';

  // For short/common titles, add disambiguators
  const words = show.title.split(/\s+/).filter(w => w.length > 2);
  const needsDisambig = words.length <= 2;

  const type = show.type === 'Musical' ? 'musical' : (show.type === 'Play' ? 'play' : '');

  if (needsDisambig && type) {
    return `"${show.title}" ${market} ${type} official website`;
  }
  return `"${show.title}" ${market} official website`;
}

/**
 * Check if a SERP result looks like a dedicated show website.
 * Prefer domains that contain the show name or common patterns.
 */
function scoreCandidate(url, serpTitle, showTitle) {
  const domain = getDomain(url);
  const showNorm = normalizeShowName(showTitle);
  // Try both full title and primary title (before colon/subtitle) to avoid
  // subtitle words diluting match ratio for short primary names
  const primaryTitle = showTitle.includes(':') ? normalizeShowName(showTitle.split(':')[0]) : showNorm;
  const wordSets = [showNorm, primaryTitle].map(t => t.split(' ').filter(w => w.length > 2));
  let score = 0;

  // Domain contains show name words (strong signal)
  const domainNorm = domain.replace(/[.-]/g, '');
  const domainMatches = wordSets.some(words => {
    const matchCount = words.filter(w => domainNorm.includes(w)).length;
    return words.length > 0 && matchCount >= Math.ceil(words.length * 0.5);
  });
  if (domainMatches) {
    score += 3;
  }

  // Common official site domain patterns
  if (domain.match(/broadway|musical|theplay|theshow|onstage|onbroadway/)) score += 1;
  if (domain.endsWith('.com')) score += 1;

  // SERP title contains show name
  const titleNorm = normalizeShowName(serpTitle || '');
  const titleMatches = wordSets.some(words => {
    const matchCount = words.filter(w => titleNorm.includes(w)).length;
    return words.length > 0 && matchCount >= Math.ceil(words.length * 0.5);
  });
  if (titleMatches) {
    score += 2;
  }

  // SERP title says "official" (strong signal)
  if (titleNorm.includes('official')) score += 2;

  return score;
}

/**
 * Discover a show's official website via SERP. Returns the URL string, or
 * null when no high-confidence, reachable candidate was found.
 */
async function discoverOfficialUrl(show) {
  const query = buildSearchQuery(show);

  try {
    const results = await serpQuery(query);
    if (!results) return null;

    // Score and filter candidates
    const candidates = [];
    for (const r of results) {
      const url = r.url;
      if (!url) continue;
      if (isBlockedDomain(url)) continue;

      const s = scoreCandidate(url, r.title || '', show.title);
      // Off-Broadway/off-west-end shows need a higher threshold — most fringe
      // productions don't have a dedicated website, so a lower bar lets SERP's
      // listing/review-site noise through as false "official sites" (BRO-166
      // widened this script's callers beyond Broadway/West End, where the
      // looser threshold was originally tuned and is safe to keep).
      const cat = show.category || 'broadway';
      const threshold = (cat === 'off-broadway' || cat === 'off-west-end') ? 5 : 3;
      if (s >= threshold) {
        candidates.push({ url, title: r.title, score: s });
      }
    }

    if (candidates.length === 0) return null;

    // Take highest-scoring candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // HEAD verify the URL is reachable
    const status = await httpHead(best.url);
    if (status >= 200 && status < 400) {
      return best.url;
    }

    console.log(`  ⚠ Best candidate for "${show.id || show.title}" returned HTTP ${status}: ${best.url}`);
    return null;
  } catch (e) {
    // Surface real provider/network failures — distinct from the routine
    // "SERP returned nothing high-confidence" case above, which is silent by
    // design. Without this, a SCRAPINGBEE outage looks identical to genuine
    // absence of an official site, and a caller (ob-discovery-ticket-links.js)
    // could persist a lower-confidence venue fallback during the outage
    // instead of retrying SERP discovery on the next run.
    console.log(`  ⚠ SERP error for "${show.id || show.title}": ${e.message}`);
    return null;
  }
}

module.exports = {
  BLOCKED_DOMAINS,
  httpHead,
  normalizeShowName,
  getDomain,
  isBlockedDomain,
  buildSearchQuery,
  scoreCandidate,
  discoverOfficialUrl,
};
