/**
 * Link-preview cards for the Profitability Scorecard (/biz, its topic pages, and one
 * per season; BRO-6149). Every card is evergreen: titles and one-line hooks
 * only, no figure that can go stale. Rendered by scripts/generate-biz-og-images.js
 * from public/og/biz.html into public/og/biz/<slug>.png.
 *
 * Titles mirror the page's own TITLE so a shared link and the page agree.
 */
const { getSeasonForDate } = require('./broadway-seasons');

// Shared by the renderer and coverage audit. Include every commercial entry,
// a superset of the tracked records listed by getSeasonsWithCommercialData().
function seasonsWithData(rawShows, commercial) {
  const shows = Array.isArray(rawShows) ? rawShows : rawShows.shows;
  const seasons = new Set();
  for (const show of shows) {
    if (!show.openingDate || !commercial.shows[show.slug]) continue;
    seasons.add(getSeasonForDate(show.openingDate));
  }
  return [...seasons].sort();
}

const TOPIC_CARDS = [
  { slug: 'musicals-since-reopening', title: 'Broadway Musicals Since the Reopening', sub: 'Which recouped, which finished in the red, and which are still running.' },
  { slug: 'reviews-and-money', title: 'What Predicts the Money?', sub: 'Critic scores, audience scores and Tony results against recoupment.' },
  { slug: 'fastest-recoups', title: 'Broadway’s Fastest Recoupments', sub: 'Shows that paid back their investors fastest, ranked by weeks.' },
  { slug: 'biggest-flops', title: 'Broadway’s Biggest Flops Since the Reopening', sub: 'Shows that finished in the red, ranked by the capital they raised.' },
  { slug: 'tony-winners', title: 'What Happened to the Tony Winners’ Investors', sub: 'Best Musical and Best Play winners, and whether each recouped.' },
  { slug: 'stunt-casting', title: 'Stunt Casting on Broadway', sub: 'How often a film or TV star leads, and whether it pays.' },
];

const HOME_CARD = {
  slug: 'home',
  kicker: 'Profitability Scorecard',
  title: 'Who made money on Broadway, and who lost it',
  sub: 'Recoupment, capitalization and running costs for every show.',
};

const SEASON_FALLBACK_CARD = {
  slug: 'season',
  kicker: 'Profitability Scorecard',
  title: 'Every Broadway Season, Show by Show',
  sub: 'Who recouped, who finished in the red.',
};

/** "2024-2025" -> "2024–25" */
function seasonLabel(season) {
  return `${season.slice(0, 4)}–${season.slice(7)}`;
}

function seasonCard(season) {
  return {
    slug: `season-${season}`,
    kicker: 'Profitability Scorecard',
    title: `The ${seasonLabel(season)} Broadway Season`,
    sub: 'Every show: who recouped, who finished in the red.',
  };
}

module.exports = { TOPIC_CARDS, HOME_CARD, SEASON_FALLBACK_CARD, seasonCard, seasonLabel, seasonsWithData };
