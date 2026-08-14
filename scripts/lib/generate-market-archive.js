/**
 * Shared generator for a market's "closed shows" archive JSON — lazy-loaded
 * by browse pages whose server component only ever passes active
 * (open/previews) shows as props, so closed shows are otherwise invisible to
 * that page's own search/filter box even with Status: All/Closed selected
 * (#1425, #1448).
 *
 * Used by:
 *   - scripts/generate-off-broadway-archive.js
 *   - scripts/generate-off-west-end-archive.js
 */

const fs = require('fs');
const path = require('path');
const { computeCriticScore: _computeRaw } = require('./compute-critic-score');
const { loadReviewsWithBlog } = require('./load-reviews-with-blog');

const dataDir = path.join(__dirname, '../../data');
const outputDir = path.join(__dirname, '../../public/data');

const SCORE_DISPLAY_YEAR_CUTOFF = 2005;
const MIN_AUDIENCE_REVIEWS = 15;

function getAudienceGrade(score) {
  if (score == null) return null;
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#fff', tooltip: 'Audiences love it' };
  if (score >= 88) return { grade: 'A', label: 'Loving It', color: '#16a34a', textColor: '#fff', tooltip: 'Audiences love it' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#fff', tooltip: 'Strong audience reception' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#fff', tooltip: 'Strong audience reception' };
  if (score >= 73) return { grade: 'B', label: 'Shrugging', color: '#f59e0b', textColor: '#000', tooltip: 'Mixed audience reception' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#000', tooltip: 'Mixed audience reception' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking It', color: '#ef4444', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 58) return { grade: 'C', label: 'Disliking It', color: '#dc2626', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking It', color: '#b91c1c', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 48) return { grade: 'D', label: 'Loathing It', color: '#991b1b', textColor: '#fff', tooltip: 'Very poor reception' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#fff', tooltip: 'Very poor reception' };
}

function getReviewYearNote(show, showReviews) {
  if (!show.openingDate || !showReviews || showReviews.length < 3) return undefined;
  const openYear = new Date(show.openingDate).getFullYear();
  const now = new Date().getFullYear();
  if (now - openYear < 10) return undefined;
  return `Reviews from ${openYear}`;
}

/**
 * @param {object} opts
 * @param {string} opts.outputFilename - e.g. 'off-broadway-archive.json'
 * @param {string} opts.entryCategory - category stamped on every entry + passed
 *   to computeCriticScore for tier/region lookup (e.g. 'off-broadway',
 *   'off-west-end'). Off-West End theatrical shows routed here by genre still
 *   score correctly since compute-critic-score.js treats west-end/off-west-end
 *   as the same 'london' scoring region.
 * @param {(show: object) => boolean} opts.belongsToMarket - market membership
 *   predicate (mirrors the getXShows() filter in data-core.ts).
 * @param {string} opts.label - human label for log output, e.g. 'Off-Broadway'
 */
function generateMarketArchive({ outputFilename, entryCategory, belongsToMarket, label }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let shows = [];
  let reviews = [];
  let outletRegistry = {};
  let audienceBuzz = {};

  try {
    const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
    shows = showsData.shows || [];
  } catch (err) {
    console.warn(`⚠ shows.json not found — generating empty ${outputFilename}`);
  }

  reviews = loadReviewsWithBlog();
  if (reviews.length === 0) {
    console.warn('⚠ reviews.json not found — scores will be null');
  }

  try {
    const registryData = JSON.parse(fs.readFileSync(path.join(dataDir, 'outlet-registry.json'), 'utf-8'));
    outletRegistry = registryData.outlets || {};
  } catch (err) {
    console.warn('⚠ outlet-registry.json not found — using default tiers');
  }

  try {
    const buzzData = JSON.parse(fs.readFileSync(path.join(dataDir, 'audience-buzz.json'), 'utf-8'));
    audienceBuzz = buzzData.shows || {};
  } catch (err) {
    console.warn('⚠ audience-buzz.json not found — audience grades will be null');
  }

  const reviewsByShow = {};
  for (const review of reviews) {
    if (!reviewsByShow[review.showId]) reviewsByShow[review.showId] = [];
    reviewsByShow[review.showId].push(review);
  }

  function computeCriticScore(showReviews) {
    const result = _computeRaw(showReviews, outletRegistry, entryCategory);
    if (!result) return null;
    return { score: result.s, reviewCount: result.rc, tier1Count: result.t1, tier2Count: result.t2 };
  }

  // Closed shows in this market with 5+ scored reviews
  const archiveShows = shows.filter(show => {
    if (show.status !== 'closed') return false;
    if (!belongsToMarket(show)) return false;
    const showReviews = reviewsByShow[show.id] || [];
    return showReviews.length >= 5;
  });

  const archiveData = archiveShows.map(show => {
    const showReviews = reviewsByShow[show.id] || [];

    const openingYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 9999;
    const hideReviews = openingYear < SCORE_DISPLAY_YEAR_CUTOFF;
    const criticScore = hideReviews ? null : computeCriticScore(showReviews);

    const buzz = audienceBuzz[show.id];
    let audienceCombinedScore = null;
    let audienceGrade = null;
    if (buzz && buzz.combinedScore != null) {
      const totalReviews = (buzz.sources?.showScore?.reviewCount || 0)
        + (buzz.sources?.mezzanine?.reviewCount || 0)
        + (buzz.sources?.reddit?.reviewCount || 0);
      if (totalReviews >= MIN_AUDIENCE_REVIEWS) {
        audienceCombinedScore = buzz.combinedScore;
        audienceGrade = getAudienceGrade(buzz.combinedScore);
      }
    }

    const entry = {
      id: show.id,
      slug: show.slug,
      title: show.title,
      venue: show.venue || '',
      openingDate: show.openingDate,
      status: show.status,
      type: show.type,
      // ShowListCard defaults an unset category to 'broadway' — always set it
      // explicitly here, mirroring serializeShow's category override for the
      // page's active shows.
      category: entryCategory,
      audienceCombinedScore,
      audienceGrade,
    };

    if (show.closingDate) entry.closingDate = show.closingDate;
    if (show.isRevival) entry.isRevival = true;
    if (show.tags?.length > 0) entry.tags = show.tags;
    if (show.creativeTeam?.length > 0) entry.creativeTeam = show.creativeTeam;
    if (show.images) entry.images = show.images;
    if (criticScore) entry.criticScore = criticScore;

    const reviewYearNote = getReviewYearNote(show, showReviews);
    if (reviewYearNote) entry.reviewYearNote = reviewYearNote;

    return entry;
  });

  const outputPath = path.join(outputDir, outputFilename);
  fs.writeFileSync(outputPath, JSON.stringify(archiveData));

  const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
  const withScores = archiveData.filter(s => s.criticScore).length;

  console.log(`✓ Generated ${outputFilename}: ${archiveData.length} closed shows (${sizeKB}KB)`);
  console.log(`  ${withScores} with critic scores`);

  return archiveData;
}

module.exports = { generateMarketArchive };
