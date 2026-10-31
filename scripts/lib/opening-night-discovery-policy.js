'use strict';

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./venue-classification');
const { UK_SERP_REGIONS } = require('./outlet-region-map');
const { isInOpeningWindow } = require('./opening-window-backoff');

// The poller's existing London supplement, including the two T4 outlets
// missing from the Holy Fool sweep. Registry entries supply domains and tiers.
const LONDON_SUPPLEMENT = [
  'new-statesman', 'afridiziak-theatre-news', 'theatreandtonic',
  'west-end-best-friend', 'all-that-dazzles-uk',
  'london-box-office', 'artsdesk', 'theatre-weekly', 'theupcoming',
  'musical-theatre-review', 'british-theatre', 'britishtheatrecom', 'everything-theatre',
  'londonist', 'thereviewshub', 'city-am', 'a-younger-theatre',
  'west-end-wilma', 'digital-spy', 'monstagigz',
  'radio-times', 'attitude', 'metro-uk', 'lost-in-theatreland',
  'the-spectator-uk', 'shy-strange-manic',
  'the-spy-in-the-stalls', 'readaboutstuff',
];

function outletRow(id, outlet, tier = outlet.tier) {
  return { id, name: outlet.displayName || id, tier, domain: outlet.domain, isDualMarket: !!outlet.isDualMarket };
}

function selectMissingT1T2Outlets(registry, foundIds, market, tierFor) {
  const missing = [];
  for (const [id, outlet] of Object.entries(registry.outlets || registry)) {
    const tier = tierFor(id);
    if (tier > 2 || foundIds.has(id.toLowerCase())) continue;
    const localUK = UK_SERP_REGIONS.has(outlet.region);
    if (isLondonMarket(market) && !outlet.isDualMarket && !localUK) continue;
    if (market === 'broadway' && outlet.region === 'uk' && !outlet.isDualMarket) continue;
    missing.push(outletRow(id, outlet, tier));
  }
  return missing.sort((a, b) => a.tier - b.tier);
}

function getLondonSupplementalOutlets(registry, foundIds, show, now = new Date()) {
  if (!isLondonMarket(show.category)) return [];
  const days = show.openingDate ? (+now - Date.parse(show.openingDate)) / 86400000 : 999;
  // Fringe specialists publish on press night too. Keep the existing delay
  // for West End shows, but do not impose it on Off-West-End discovery.
  if (show.category !== 'off-west-end' && days < 1) return [];
  const outlets = registry.outlets || registry;
  return LONDON_SUPPLEMENT.filter(id => outlets[id]?.domain && !foundIds.has(id.toLowerCase()))
    .map(id => outletRow(id, outlets[id]));
}

function reviewSearchKeyword(show) {
  // Off-West-End articles often never say "West End". The title, outlet
  // domain and production date window already constrain these searches.
  if (show.category === 'off-west-end') return 'review';
  if (isLondonMarket(show.category)) return 'West End review';
  return show.category === 'off-broadway' ? 'Off-Broadway review' : 'Broadway review';
}

function rotateMissingOutlets(outlets, offset = 0) {
  if (!outlets.length) return [];
  const start = Math.max(0, offset) % outlets.length;
  return [...outlets.slice(start), ...outlets.slice(0, start)];
}

const STALLED_STUB_MAX_HOURS = 72;
const STUB_EXCLUDED_FLAGS = ['wrongShow', 'wrongProduction', 'isRoundupArticle', 'duplicateOf', 'fabricatedEntry', 'isNonReview'];

function findStalledReviewStubs(show, showDir, now = new Date()) {
  if (!show.openingDate || !isInOpeningWindow(show, now) || !fs.existsSync(showDir)) return [];
  const stalled = [];
  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const filePath = path.join(showDir, file);
    try {
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (review.contentTier !== 'stub' || (review.fullText || '').length !== 0) continue;
      // BRO-6682 (BRO-6670 #33): a stub the pipeline already excluded (news
      // article, wrong show, roundup, duplicate) is not a stalled collection;
      // warning on it every poll for weeks (variety--cynthia-littleton) hid the
      // real stalls.
      if (STUB_EXCLUDED_FLAGS.some((f) => review[f])) continue;
      // firstSeenAt is immutable at the writer. mtime is a conservative
      // fallback for older files that predate that discovery clock.
      const seen = Date.parse(review.firstSeenAt);
      const ageHours = (+now - (Number.isFinite(seen) ? seen : fs.statSync(filePath).mtimeMs)) / 3600000;
      // Collection that has not completed three days after the first poll is
      // abandoned, not stalled (frontmezzjunkies--unknown sat at 529h).
      if (ageHours > 2 && ageHours <= STALLED_STUB_MAX_HOURS) stalled.push({ file, ageHours });
    } catch { /* Other validity checks report malformed files. */ }
  }
  return stalled;
}

function warnStalledReviewStubs(show, showDir, { now = new Date(), log = console.warn, githubActions = !!process.env.GITHUB_ACTIONS } = {}) {
  const stalled = findStalledReviewStubs(show, showDir, now);
  for (const { file, ageHours } of stalled) {
    log(`${githubActions ? '::warning::' : ''}COLLECTION STALLED: ${show.id}/${file} contentTier=stub len=0 for ${ageHours.toFixed(1)}h. Collection has not completed; retry collection for this show.`);
  }
  return stalled;
}

module.exports = { selectMissingT1T2Outlets, getLondonSupplementalOutlets, reviewSearchKeyword, rotateMissingOutlets, STALLED_STUB_MAX_HOURS, findStalledReviewStubs, warnStalledReviewStubs };
