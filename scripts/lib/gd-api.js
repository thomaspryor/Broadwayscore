/**
 * gd-api.js — Shared primitives for Gold Derby's WordPress REST API.
 *
 * Endpoints:
 *   GET /wp-json/gameplay/v1/featured-leagues/tony
 *     → list of all Tony leagues (2013–current)
 *   GET /wp-json/gameplay/v1/categories-titles/{leagueId}
 *     → { data: { [categoryId]: categoryName } }
 *   GET /wp-json/gameplay/v1/latest-odds-v3/{leagueId}/{categoryId}/combined
 *     → [{ id, title, related_title, votes, fraction, percentage, is_winner }]
 *
 * Why this exists: the live scraper `scrape-gold-derby-tonys.js` and the
 * historical-backfill mode both hit the same API. Sharing these primitives
 * means a fix or schema change lands in one place.
 *
 * Pure functions only. No fs writes, no process.exit. Progress logged via
 * console.error so stdout stays clean for JSON consumers.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeTitle, titlesMatch } = require('./title-normalization');

const GD_BASE = 'https://www.goldderby.com/wp-json/gameplay/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cacheKeyFor(pathSuffix) {
  return crypto.createHash('sha1').update(pathSuffix).digest('hex').slice(0, 16);
}

/**
 * GET a Gold Derby JSON endpoint. Optional read-through cache.
 *
 * @param {string} pathSuffix — e.g. '/featured-leagues/tony'
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] — if set, reads/writes JSON cache at `${cacheDir}/${sha1}.json`
 * @param {number} [opts.ttlMs] — if set, cache hits older than this trigger a refetch
 * @returns {Promise<any>}
 */
async function gdGet(pathSuffix, opts = {}) {
  const { cacheDir, ttlMs } = opts;
  const url = `${GD_BASE}${pathSuffix}`;

  if (cacheDir) {
    const cachePath = path.join(cacheDir, `${cacheKeyFor(pathSuffix)}.json`);
    try {
      const stat = fs.statSync(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (!ttlMs || ageMs < ttlMs) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.goldderby.com/odds/combined-odds/broadway-2026-tony-awards-predictions/',
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const body = await res.json();

  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${cacheKeyFor(pathSuffix)}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(body));
  }

  return body;
}

async function findTonyLeagues(season) {
  const search = await gdGet('/featured-leagues/tony');
  if (!search?.data || !Array.isArray(search.data)) {
    throw new Error('featured-leagues/tony returned unexpected shape');
  }
  const nomsName = `Tony Awards Nominations ${season}`;
  const winsName = `Tony Awards ${season}`;
  const nominations = search.data.find(l => l.featured_league_short_name === nomsName);
  const winners = search.data.find(l => l.featured_league_short_name === winsName);
  return { nominations, winners };
}

async function fetchLeagueOdds(leagueId) {
  const titlesRes = await gdGet(`/categories-titles/${leagueId}`);
  const categoryMap = titlesRes?.data || {};
  const categories = Object.entries(categoryMap);
  const results = {};
  for (const [catId, catName] of categories) {
    try {
      const odds = await gdGet(`/latest-odds-v3/${leagueId}/${catId}/combined`);
      results[catName] = Array.isArray(odds) ? odds : [];
    } catch (err) {
      console.error(`  [warn] category ${catId} (${catName}): ${err.message}`);
      results[catName] = [];
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

function parsePercentage(pctStr) {
  if (pctStr == null) return 0;
  const n = parseFloat(String(pctStr).replace('%', '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n / 100));
}

function matchShow(gdTitle, gdRelatedTitle, shows) {
  // Best Musical / Play: show is in gdTitle. related_title may be empty or a
  // subtitle ("Two Strangers" + "Carry a Cake Across New York").
  // Acting / design: gdTitle is the person's name, related_title is the show.
  // Try candidates in order: title, related_title alone, composite.
  const stripBrackets = (s) => (s || '').replace(/\s*[\[\(][^\]\)]*[\]\)]\s*/g, ' ').trim();
  const candidates = [];
  if (gdTitle) candidates.push(gdTitle.trim());
  if (gdRelatedTitle) {
    candidates.push(gdRelatedTitle.trim());
    const stripped = stripBrackets(gdRelatedTitle);
    if (stripped && stripped !== gdRelatedTitle.trim()) candidates.push(stripped);
  }
  if (gdTitle && gdRelatedTitle) candidates.push(`${gdTitle.trim()} ${gdRelatedTitle.trim()}`);

  let best = null;
  for (const cand of candidates) {
    for (const s of shows) {
      if (titlesMatch(s.title, cand)) {
        if (!best) best = s;
        else if (s.openingDate && (!best.openingDate || s.openingDate > best.openingDate)) {
          best = s;
        }
      }
    }
    if (best) return best;
  }
  for (const cand of candidates) {
    const candNorm = normalizeTitle(cand);
    for (const s of shows) {
      if (normalizeTitle(s.title) === candNorm) return s;
    }
  }
  // Last-resort: strip common show-title subtitles ("Beaches, A New Musical" → "Beaches").
  const stripSubtitle = (t) => (t || '').replace(/[,:]\s*(a new musical|the musical|a musical|on broadway|the play)\b.*$/i, '').trim();
  for (const cand of candidates) {
    const candNorm = normalizeTitle(cand);
    for (const s of shows) {
      if (normalizeTitle(stripSubtitle(s.title)) === candNorm) return s;
    }
  }
  return null;
}

// GD categories where row.title is a person name, not a show title.
const PERSON_LEVEL_GD_CATS = new Set([
  'Best Actor (Musical)', 'Best Actress (Musical)',
  'Best Actor (Play)', 'Best Actress (Play)',
  'Best Featured Actor (Musical)', 'Best Featured Actress (Musical)',
  'Best Featured Actor (Play)', 'Best Featured Actress (Play)',
]);

/**
 * Big Four category mapping (GoldDerby name → Tony official name).
 * Sourced from src/lib/data-tony-nominees.ts:30-57 (full mapping). Keep in
 * sync if either side renames. We only need the show-level Big Four here.
 */
const BIG_FOUR_GD_TO_TONY = {
  'Best Musical':         'Best Musical',
  'Best Play':            'Best Play',
  'Best Musical Revival': 'Best Revival of a Musical',
  'Best Play Revival':    'Best Revival of a Play',
};

/**
 * Enumerate every "winners" Tony league GD has published. Recognizes both the
 * modern "Tony Awards {YEAR}" form (2015+) and the legacy "Tonys {YEAR}" form
 * (2013–2014). Returns one entry per ceremony with the ceremonyYear extracted.
 *
 * Note: 2021 ceremony was COVID-merged with 2020 (one ceremony Sept 2021
 * awarded both 2019-20 and 2020-21 seasons). GD has only "Tony Awards 2020"
 * for this; awards.json has both seasons keyed separately. Cross-cycle
 * mapping is the caller's concern (see S4-T1).
 */
async function discoverHistoricalLeagues() {
  const all = await gdGet('/featured-leagues/tony');
  const leagues = (all.data || []).filter(l => {
    const n = l.featured_league_short_name || '';
    return /^Tony Awards \d{4}$/.test(n) || /^Tonys \d{4}$/.test(n);
  });
  return leagues.map(l => {
    const name = l.featured_league_short_name;
    const m = name.match(/(\d{4})$/);
    return {
      ceremonyYear: m ? parseInt(m[1], 10) : null,
      leagueId: l.featured_league_post_id,
      leagueName: name,
    };
  }).sort((a, b) => a.ceremonyYear - b.ceremonyYear);
}

/**
 * Look up the GD category IDs for the Big Four in a given league. Returns a
 * map keyed by Tony official names (e.g. "Best Revival of a Musical") with
 * { gdCatId, gdCatName } values.
 *
 * GD's category names are stable per the BIG_FOUR_GD_TO_TONY table, but the
 * numeric IDs vary per league. Missing categories silently omit; caller must
 * check coverage.
 */
async function findBigFourCategoryIds(leagueId) {
  const titles = await gdGet(`/categories-titles/${leagueId}`);
  const catMap = titles?.data || {};
  const out = {};
  for (const [gdCatId, gdCatName] of Object.entries(catMap)) {
    const tonyName = BIG_FOUR_GD_TO_TONY[gdCatName];
    if (tonyName) out[tonyName] = { gdCatId, gdCatName };
  }
  return out;
}

function mergeOdds(showsOut, personsOut, catName, oddsRows, shows, mode, unmatched) {
  const isPersonLevel = PERSON_LEVEL_GD_CATS.has(catName);
  for (const row of oddsRows) {
    const matched = matchShow(row.title, row.related_title, shows);
    if (!matched) {
      unmatched.push({ category: catName, title: row.title, related_title: row.related_title, percentage: row.percentage });
      continue;
    }
    const showId = matched.id;
    if (!showsOut[showId]) {
      showsOut[showId] = { title: matched.title, goldDerbyId: row.id, categories: {} };
    }
    const p = parsePercentage(row.percentage);

    // For person-level categories, store individual odds keyed by person name.
    // Show-level entry gets max pWin as a fallback for unmatched lookups.
    if (isPersonLevel && row.title && row.title !== row.related_title) {
      if (!personsOut[row.title]) personsOut[row.title] = {};
      personsOut[row.title][catName] = { pWin: p, votes: row.votes || 0 };
    }

    const existing = showsOut[showId].categories[catName] || {};
    const prevPWin = existing.pWin ?? 0;
    const prevVotes = existing.votes ?? 0;
    if (prevPWin >= p) continue; // keep max pWin for show-level fallback
    if (mode === 'pre-noms') {
      showsOut[showId].categories[catName] = {
        ...existing, pNom: p, pWin: p,
        votes: (row.votes || 0) + prevVotes, gdNomineeId: row.id,
      };
    } else {
      showsOut[showId].categories[catName] = {
        ...existing, pNom: 1.0, pWin: p,
        votes: (row.votes || 0) + prevVotes, gdNomineeId: row.id,
      };
    }
  }
}

module.exports = {
  GD_BASE,
  UA,
  gdGet,
  findTonyLeagues,
  fetchLeagueOdds,
  parsePercentage,
  matchShow,
  PERSON_LEVEL_GD_CATS,
  mergeOdds,
  BIG_FOUR_GD_TO_TONY,
  discoverHistoricalLeagues,
  findBigFourCategoryIds,
};
