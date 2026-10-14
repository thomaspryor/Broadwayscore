#!/usr/bin/env node
/**
 * generate-fantasy-config.js — Generates data/fantasy-league.json
 *
 * Reads shows.json, the public slim show files (canonical CriticScore),
 * audience-buzz.json and grosses-history.json; identifies the season's
 * draftable shows; prices them; writes the fantasy league configuration.
 *
 * Season constants come from src/config/fantasy-season.json (one file shared
 * with the site and the API). Prices come from data/fantasy-league-frozen.json:
 *
 *   --refreeze   Rebuild the catalog AND prices from scratch with the
 *                pre-season EV model (scripts/lib/fantasy-pricing.js +
 *                data/fantasy-preseason-priors.json). Refused once the draft
 *                has opened unless --force: entries already hold prices.
 *   (default)    Keep every frozen show at its frozen price (never drop a show
 *                a player may have drafted), refresh its mutable fields
 *                (status, closing date, scores, image), and APPEND any newly
 *                eligible show at a freshly computed price. The weekly
 *                workflow runs this mode.
 *   --dry-run    Print the config to stdout, write nothing.
 *   --list       Print a price table to stderr.
 *
 * Usage: node scripts/generate-fantasy-config.js [--refreeze] [--force] [--dry-run] [--list]
 */

const fs = require('fs');
const path = require('path');
const { isBroadwayCategory } = require('./lib/venue-classification');
const { foldDiacritics } = require('./lib/title-match');
const pricing = require('./lib/fantasy-pricing');

const seasonConfig = require('../src/config/fantasy-season.json');

const SEASON = seasonConfig.season;
const BUDGET = seasonConfig.budget;
const TEAM_SIZE = seasonConfig.teamSize;
const DRAFT_OPENS = seasonConfig.draftOpens;
const DRAFT_DEADLINE = seasonConfig.draftDeadline;
const SCORING_START = seasonConfig.scoringStart;
const SCORING_END = seasonConfig.scoringEnd;
const EARLY_BIRD_CUTOFF = seasonConfig.earlyBirdCutoff;
const TONY_WINDOW = seasonConfig.tonyWindow;
const SCORING = seasonConfig.scoring;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const refreeze = args.includes('--refreeze');
const force = args.includes('--force');
const listPrices = args.includes('--list');

// ── Load data ───────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const slimDir = path.join(__dirname, '..', 'public', 'data', 'shows');
const leaguePath = path.join(dataDir, 'fantasy-league.json');
const frozenPath = path.join(dataDir, 'fantasy-league-frozen.json');
const priorsPath = path.join(dataDir, 'fantasy-preseason-priors.json');
const evPath = path.join(dataDir, 'fantasy-ev.json');

const showsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
const shows = showsRaw.shows;
const allShows = Array.isArray(shows) ? shows : Object.values(shows);
const showById = new Map(allShows.map(s => [s.id, s]));

const priorsRaw = fs.existsSync(priorsPath) ? JSON.parse(fs.readFileSync(priorsPath, 'utf8')) : { _meta: {}, shows: {} };
if (priorsRaw._meta?.season && priorsRaw._meta.season !== SEASON) {
  console.error(`WARNING: ${path.basename(priorsPath)} is for season ${priorsRaw._meta.season}, config is ${SEASON}. Tiers will default to 3.`);
  priorsRaw.shows = {};
}
const weeklyGrossPriors = priorsRaw._meta?.weeklyGrossPriors || {};
const categorySlots = priorsRaw._meta?.categorySlots || {};
// Fold diacritics BEFORE the ASCII strip (task #648): "Les Misérables" must
// key as "lesmiserables", not shred at the accent and miss its byTitle prior.
const normTitle = t => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
const priorsByTitle = Object.fromEntries(Object.entries(priorsRaw.byTitle || {}).filter(([k]) => !k.startsWith('_')));
// Priors keyed by show id, with a normalized-title fallback for shows that
// were announced (and tiered) before they existed in shows.json.
const priorsById = new Proxy(priorsRaw.shows || {}, {
  get(target, id) {
    if (typeof id !== 'string') return undefined;
    if (target[id]) return target[id];
    const title = showById.get(id)?.title;
    const byTitle = title ? priorsByTitle[normTitle(title)] : null;
    if (byTitle) return byTitle;
    return undefined;
  },
});

let existingLeague = null;
try { existingLeague = JSON.parse(fs.readFileSync(leaguePath, 'utf8')); } catch { /* first run */ }
if (existingLeague && existingLeague._meta?.season !== SEASON) existingLeague = null;

let frozen = null;
try {
  const raw = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
  if (raw._meta?.season === SEASON) frozen = raw;
  else console.error(`Ignoring frozen prices for season ${raw._meta?.season ?? 'unknown'} (config is ${SEASON}).`);
} catch { /* no snapshot yet */ }

// DRAFT_OPENS is a New York calendar date (same rule as src/config/fantasy.ts isDraftOpen).
const { nyDate } = require('./lib/fantasy-helpers');
const draftHasOpened = nyDate(new Date().toISOString()) >= DRAFT_OPENS;
if (refreeze && draftHasOpened && !force) {
  console.error(`REFUSED: --refreeze after the draft opened (${DRAFT_OPENS}) would reprice shows players already drafted. Re-run with --force only if no entries exist.`);
  process.exit(2);
}
if (!frozen && !refreeze) {
  console.error('No frozen price snapshot for this season. Run with --refreeze to build one.');
  process.exit(2);
}

// ── Audience data (audience-buzz.json has combinedScore per show) ───
let audienceData = {};
try {
  const buzzRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'audience-buzz.json'), 'utf8'));
  const buzzShows = buzzRaw.shows || buzzRaw;
  for (const [showId, data] of Object.entries(buzzShows)) {
    if (showId === '_meta' || showId === 'lastUpdated') continue;
    if (data && data.combinedScore != null) audienceData[showId] = data;
  }
} catch (e) {
  console.error('Warning: Could not load audience-buzz.json:', e.message);
}

// ── Grosses (trailing average for open shows) ───────────────────────
let grossWeeks = {};
try {
  grossWeeks = JSON.parse(fs.readFileSync(path.join(dataDir, 'grosses-history.json'), 'utf8')).weeks || {};
} catch (e) {
  console.error('Warning: Could not load grosses-history.json:', e.message);
}
function trailingWeeklyGross(slug, n = 4) {
  const weeks = Object.keys(grossWeeks).sort();
  const observed = [];
  for (let i = weeks.length - 1; i >= 0 && observed.length < n; i--) {
    const row = grossWeeks[weeks[i]]?.[slug];
    if (row && row.gross > 0) observed.push(row.gross);
  }
  if (observed.length === 0) return null;
  return Math.round(observed.reduce((a, b) => a + b, 0) / observed.length);
}

// ── Venue capacity (weekly gross ceiling) ───────────────────────────
let theaterMeta = {};
try { theaterMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'theater-metadata.json'), 'utf8')); } catch { /* optional */ }
const venueNorm = s => foldDiacritics(String(s || '')).toLowerCase().replace(/theatre|theater/g, '').replace(/[^a-z]/g, '');
const venueKeys = Object.keys(theaterMeta).filter(k => k !== '_meta');
function venueCapacity(venue) {
  if (!venue) return null;
  if (theaterMeta[venue]?.capacity) return theaterMeta[venue].capacity;
  const n = venueNorm(venue);
  const hit = venueKeys.find(k => venueNorm(k) === n)
    || venueKeys.find(k => n.includes(venueNorm(k)) || venueNorm(k).includes(n));
  return hit ? theaterMeta[hit].capacity || null : null;
}

// ── Scores ──────────────────────────────────────────────────────────
// CriticScore: the public slim file is the canonical, site-parity source
// (scripts/lib/canonical-critic-scores.ts). Fall back to the shared scorer
// only when a slim file is missing (fresh show before the next rebuild).
const { computeCriticScore: sharedComputeCriticScore } = require('./lib/compute-critic-score');
const outletRegistry = (() => { try { return require('../data/outlet-registry.json').outlets || {}; } catch { return {}; } })();
let reviewsByShow = null;
const MIN_REVIEWS_FOR_SCORE = 5;
function computeCriticScore(showId) {
  const slimPath = path.join(slimDir, `${showId}.json`);
  if (fs.existsSync(slimPath)) {
    try {
      const slim = JSON.parse(fs.readFileSync(slimPath, 'utf8'));
      return typeof slim.cs === 'number' ? slim.cs : null;
    } catch { /* fall through */ }
  }
  if (!reviewsByShow) {
    reviewsByShow = new Map();
    try {
      const reviews = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8')).reviews || [];
      for (const r of reviews) {
        if (r.assignedScore == null) continue;
        if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
        reviewsByShow.get(r.showId).push(r);
      }
    } catch { /* no reviews.json */ }
  }
  const showReviews = reviewsByShow.get(showId) || [];
  if (showReviews.length < MIN_REVIEWS_FOR_SCORE) return null;
  const result = sharedComputeCriticScore(showReviews, outletRegistry, showById.get(showId)?.category);
  return result ? result.s : null;
}

// Tier mappers shared with compute-fantasy-scores.js; pinned to the site's
// scoring.ts / audience-grade-utils.ts by tests/unit/fantasy-tier-parity.test.ts.
const { criticLabelForScore: getCriticLabel, audienceGradeForScore: gradeFromAudienceScore } = require('./lib/fantasy-helpers');
const MIN_AUDIENCE_REVIEWS = 15;
function getAudienceGrade(showId) {
  const data = audienceData[showId];
  if (!data || !data.sources) return null;
  let totalReviews = 0;
  for (const source of Object.values(data.sources)) totalReviews += source?.reviewCount || 0;
  if (totalReviews < MIN_AUDIENCE_REVIEWS) return null;
  return gradeFromAudienceScore(data.combinedScore);
}

// ── Eligibility ─────────────────────────────────────────────────────
function inTonyWindow(show) {
  return !!show.openingDate && show.openingDate >= TONY_WINDOW.start && show.openingDate <= TONY_WINDOW.end;
}

function isEligibleBroadway(show) {
  if (show._devOnly) return false;
  if (priorsById[show.id]?.exclude) return false;
  if (!isBroadwayCategory(show)) return false;
  if (show.type === 'special' || show.type === 'opera') return false;
  return inTonyWindow(show);
}

// Off-Broadway: the awards-eligible institutional houses (Lortel / Drama Desk /
// OCC territory) plus the commercial houses that mount awards-caliber runs.
const OB_VENUE_RE = /public theater|new york theatre workshop|playwrights horizons|new york city center|lct3|claire tow|mitzi e\. newhouse|lincoln center theater|atlantic theater|laura pels|roundabout|second stage|signature (theatre|center)|pershing square signature|vineyard theatre|mcc theater|newman mills|classic stage|irish repertory|st\. ann's warehouse|bam harvey|the shed|theatre for a new audience|polonsky|la mama|wp theater|rattlestick|ars nova|soho rep|minetta lane|studio seaview|daryl roth|orpheum theatre|greenwich house|lucille lortel|cherry lane|new world stages|westside theatre/i;
const OB_MAX = 24;

function isEligibleOffBroadway(show) {
  if (show._devOnly) return false;
  if (priorsById[show.id]?.exclude) return false;
  if (show.category !== 'off-broadway') return false;
  if (!['play', 'musical'].includes(show.type)) return false;
  if (!inTonyWindow(show)) return false;
  if (show.status === 'closed') return false;
  return OB_VENUE_RE.test(show.venue || '');
}

function selectOffBroadway(candidates) {
  // Shows still to open earn on every pillar; already-open ones are
  // CriticScore-locked (see below) so only award-caliber ones make the cut.
  const tierOf = s => pricing.clampTier(priorsById[s.id]?.tier);
  const notYetOpen = candidates
    .filter(s => s.openingDate >= DRAFT_OPENS)
    .sort((a, b) => (tierOf(b) - tierOf(a)) || a.openingDate.localeCompare(b.openingDate));
  const alreadyOpen = candidates
    .filter(s => s.openingDate < DRAFT_OPENS)
    .map(s => ({ show: s, cs: computeCriticScore(s.id) }))
    .filter(x => x.cs != null && x.cs >= 80)
    .sort((a, b) => b.cs - a.cs)
    .map(x => x.show);
  return [...notYetOpen, ...alreadyOpen].slice(0, OB_MAX);
}

// ── Build the catalog ───────────────────────────────────────────────
const bwEligible = allShows.filter(isEligibleBroadway);
const obEligible = selectOffBroadway(allShows.filter(isEligibleOffBroadway));

const catalogIds = new Set();
const dropped = [];
if (frozen && !refreeze) {
  // Append-only: every frozen show stays draftable at its frozen price.
  for (const id of Object.keys(frozen.prices)) catalogIds.add(id);
  for (const s of bwEligible) {
    if (!catalogIds.has(s.id)) {
      const prior = priorsById[s.id];
      console.error(`  NEW Broadway show since freeze: ${s.id} — pricing it now (${prior ? `tier ${prior.tier}` : 'NO PRIOR: default tier 3, set one in data/fantasy-preseason-priors.json'})`);
    }
    catalogIds.add(s.id);
  }
  // Off-Broadway additions only when the catalog still has room.
  for (const s of obEligible) {
    if (catalogIds.has(s.id)) continue;
    const obCount = [...catalogIds].filter(id => (showById.get(id) || existingLeague?.shows?.[id])?.category === 'off-broadway').length;
    if (obCount >= OB_MAX) break;
    console.error(`  NEW Off-Broadway show since freeze: ${s.id} — pricing it now`);
    catalogIds.add(s.id);
  }
} else {
  for (const s of bwEligible) catalogIds.add(s.id);
  for (const s of obEligible) catalogIds.add(s.id);
}

// Resolve show rows (a frozen show that vanished from shows.json keeps its
// last published entry so drafted rosters never lose a title or its points).
const catalog = [];
for (const id of catalogIds) {
  const row = showById.get(id);
  if (row) { catalog.push(row); continue; }
  const prev = existingLeague?.shows?.[id];
  if (prev) {
    console.error(`  WARN: ${id} no longer in shows.json — keeping last published entry`);
    catalog.push({ id, title: prev.title, slug: prev.slug, type: prev.type, category: prev.category, status: prev.status, openingDate: prev.openingDate, closingDate: prev.closingDate ?? null, isRevival: prev.isRevival ?? false, images: prev.image ? { thumbnail: prev.image } : {} , _stale: true });
  } else {
    dropped.push(id);
    console.error(`  WARN: ${id} is in the frozen snapshot but unknown — dropped`);
  }
}

console.error(`Catalog: ${catalog.length} shows (${catalog.filter(isBroadwayCategory).length} BW, ${catalog.filter(s => s.category === 'off-broadway').length} OB)`);

// ── Per-show facts ──────────────────────────────────────────────────
const facts = new Map();
for (const show of catalog) {
  const criticScore = computeCriticScore(show.id);
  const audienceGrade = getAudienceGrade(show.id);
  // Locked for everyone when the show opened before the draft opened: its
  // reviews were public before anyone could pick it. Shows opening later are
  // locked per entry (computeLeaderboard: drafted on/after opening night).
  const criticLocked = !!show.openingDate && show.openingDate < DRAFT_OPENS;
  const isBW = isBroadwayCategory(show);
  const trailing = isBW && ['open', 'previews'].includes(show.status) ? trailingWeeklyGross(show.slug) : null;
  facts.set(show.id, { criticScore, audienceGrade, criticLocked, isBW, trailing });
}

// ── Pricing ─────────────────────────────────────────────────────────
const categoryField = pricing.buildCategoryField(catalog.filter(s => isBroadwayCategory(s)), priorsById, categorySlots);

function projectFor(show) {
  const f = facts.get(show.id);
  return pricing.projectShowPoints(show, {
    scoring: SCORING,
    scoringStart: SCORING_START,
    scoringEnd: SCORING_END,
    priors: priorsById[show.id] || {},
    categoryField,
    criticScore: f.criticScore,
    audienceGrade: f.audienceGrade,
    criticLocked: f.criticLocked,
    trailingWeeklyGross: f.trailing,
    weeklyGrossPriors,
    venueCapacity: f.isBW ? venueCapacity(show.venue) : null,
    getCriticLabel,
  });
}

const projections = new Map();
for (const show of catalog) projections.set(show.id, projectFor(show));

let k;
let frozenOut;
if (frozen && !refreeze) {
  k = frozen._meta.k;
  frozenOut = { ...frozen, prices: { ...frozen.prices }, notes: { ...(frozen.notes || {}) }, ev: { ...(frozen.ev || {}) }, addedAt: { ...(frozen.addedAt || {}) } };
  for (const show of catalog) {
    if (frozenOut.prices[show.id] != null) continue;
    const proj = projections.get(show.id);
    frozenOut.prices[show.id] = pricing.priceFromEV(proj.totalPoints, k);
    frozenOut.notes[show.id] = pricing.priceNoteFor(proj);
    frozenOut.ev[show.id] = proj.totalPoints;
    frozenOut.addedAt[show.id] = new Date().toISOString();
  }
} else {
  const bwEvs = catalog.filter(s => isBroadwayCategory(s)).map(s => projections.get(s.id).totalPoints);
  k = pricing.calibrateK(bwEvs, { targetTopPrice: 33, topN: 3 });
  if (!k) { console.error('Could not calibrate k (no Broadway EV).'); process.exit(1); }
  const frozenAt = new Date().toISOString();
  frozenOut = {
    _meta: {
      season: SEASON,
      frozenAt,
      method: 'preseason-ev',
      k,
      targetTopPrice: 33,
      priorsUpdatedAt: priorsRaw._meta?.updatedAt || null,
      note: 'Season prices locked at draft open. generate-fantasy-config.js reads this file and emits these prices verbatim; shows announced later are appended here with addedAt. Never remove a show: players may have drafted it.',
    },
    prices: {},
    notes: {},
    ev: {},
    addedAt: {},
  };
  for (const show of catalog) {
    const proj = projections.get(show.id);
    frozenOut.prices[show.id] = pricing.priceFromEV(proj.totalPoints, k);
    frozenOut.notes[show.id] = pricing.priceNoteFor(proj);
    frozenOut.ev[show.id] = proj.totalPoints;
    frozenOut.addedAt[show.id] = frozenAt;
  }
}

// ── Assemble config ─────────────────────────────────────────────────
const showsConfig = {};
for (const show of catalog) {
  const f = facts.get(show.id);
  showsConfig[show.id] = {
    price: frozenOut.prices[show.id],
    eligible: {
      criticScore: !f.criticLocked,
      audienceGrade: !f.criticLocked,
      boxOffice: f.isBW,
      tonys: f.isBW && (priorsById[show.id]?.awardsEligible !== false),
    },
    title: show.title,
    type: show.type || 'play',
    category: show.category || 'broadway',
    status: show.status,
    openingDate: show.openingDate || null,
    closingDate: show.closingDate || null,
    isRevival: !!show.isRevival,
    criticScore: f.criticScore,
    audienceGrade: f.audienceGrade,
    slug: show.slug,
    image: show.images?.thumbnail || show.images?.poster || null,
    priceNote: frozenOut.notes[show.id] || null,
  };
}

const config = {
  _meta: {
    season: SEASON,
    draftOpens: DRAFT_OPENS,
    draftDeadline: DRAFT_DEADLINE,
    scoringStart: SCORING_START,
    scoringEnd: SCORING_END,
    earlyBirdCutoff: EARLY_BIRD_CUTOFF,
    tonyWindow: TONY_WINDOW,
    budget: BUDGET,
    teamSize: TEAM_SIZE,
    generatedAt: new Date().toISOString(),
    pricing: { source: 'frozen', frozenAt: frozenOut._meta.frozenAt, method: frozenOut._meta.method, k },
  },
  shows: showsConfig,
  scoring: SCORING,
};

// ── Report ──────────────────────────────────────────────────────────
const prices = Object.values(showsConfig).map(s => s.price);
const bwPrices = Object.values(showsConfig).filter(s => s.category === 'broadway').map(s => s.price);
const obPrices = Object.values(showsConfig).filter(s => s.category === 'off-broadway').map(s => s.price);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.error(`\nPricing summary (k=${k.toFixed(4)}):`);
console.error(`  Total shows: ${prices.length}`);
console.error(`  BW: avg $${avg(bwPrices).toFixed(0)}, range $${Math.min(...bwPrices)}-$${Math.max(...bwPrices)}`);
if (obPrices.length) console.error(`  OB: avg $${avg(obPrices).toFixed(0)}, range $${Math.min(...obPrices)}-$${Math.max(...obPrices)}`);
console.error(`  ${TEAM_SIZE}-show avg cost: $${(avg(prices) * TEAM_SIZE).toFixed(0)}`);

if (listPrices) {
  console.error('\n  Price  EV     Tier  Show');
  const rows = catalog.map(s => ({ s, p: projections.get(s.id) })).sort((a, b) => b.p.totalPoints - a.p.totalPoints);
  for (const { s, p } of rows) {
    const c = showsConfig[s.id];
    console.error(`  $${String(c.price).padStart(2)}   ${p.totalPoints.toFixed(1).padStart(6)}  ${String(p.breakdown.tier)}     ${s.title.slice(0, 44).padEnd(46)} ${c.category === 'off-broadway' ? 'OB' : ''}${c.eligible.criticScore ? '' : ' ★locked'}  CS:${p.criticScorePoints.toFixed(0)} AG:${p.audienceGradePoints.toFixed(0)} BO:${p.boxOfficePoints.toFixed(0)} AW:${p.awardsPoints.toFixed(0)}`);
  }
}

// ── Write ───────────────────────────────────────────────────────────
if (dryRun) {
  console.log(JSON.stringify(config, null, 2));
  console.error('\n--dry-run: output to stdout only');
} else {
  fs.writeFileSync(leaguePath, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(frozenPath, JSON.stringify(frozenOut, null, 2) + '\n');
  // Transparency file: the projections behind every price.
  const ev = { _meta: { mode: 'preseason', lastUpdated: new Date().toISOString(), season: SEASON, k, predictionSource: 'fantasy-preseason-priors.json' }, showScores: {} };
  for (const show of catalog) ev.showScores[show.id] = projections.get(show.id);
  fs.writeFileSync(evPath, JSON.stringify(ev, null, 2) + '\n');
  console.error(`\nWrote ${leaguePath}, ${frozenPath}, ${evPath}`);
}
