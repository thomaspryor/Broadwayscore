/**
 * Post text per network. Templates, not an LLM: every number comes straight
 * from the site's data, and nothing can be invented.
 *
 * Limits (Buffer, developers.buffer.com/guides/character-limits): X free 280,
 * Bluesky 300, Threads 500, Instagram 2,196, Facebook 5,000. We budget the full
 * URL length, so X (which counts a URL as 23) and Bluesky are both safe.
 */

const { MARKETS } = require('./config');

const LIMITS = { twitter: 280, bluesky: 300, threads: 500, instagram: 2196, facebook: 5000 };
const SHORT_BUDGET = 270; // fits X and Bluesky with margin

function showPath(show) {
  return `/show/${show.slug || show.id}`;
}

/** London shows live on westendscorecard.com (same host rule as scripts/lib/reddit-opening-post.js showUrl). */
function showUrl(show, network) {
  return `https://${MARKETS[show.category].domain}${showPath(show)}?utm_source=${network}&utm_medium=social&utm_campaign=autopost`;
}

/**
 * Patterns every caption of this post matches on every network: the show path
 * (ending at "?" or whitespace, so /show/proof never matches /show/proof-2000) and
 * the score sentence. buffer.js findExistingPost matches on them so the same post
 * is never created twice.
 */
function postMarkers(show) {
  const escaped = showPath(show).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [new RegExp(`${escaped}(?=[?\\s]|$)`), /has a Critic Score of \d/];
}

const TIER_LEAD = {
  'must-see': 'The reviews are in, and critics are raving.',
  recommended: 'The reviews are in, and critics recommend it.',
  'worth-seeing': 'The reviews are in: worth seeing, say the critics.',
  skippable: 'The reviews are in, and critics are mixed.',
  'stay-away': 'The reviews are in, and critics are not sold.',
};

function hashtagLine(show) {
  return [...MARKETS[show.category].hashtags, 'Theatre'].map(t => `#${t}`).join(' ');
}

function breakdownLine(b) {
  if (!b) return '';
  const parts = [];
  if (b.rave) parts.push(`${b.rave} rave${b.rave === 1 ? '' : 's'}`);
  if (b.positive) parts.push(`${b.positive} positive`);
  if (b.mixed) parts.push(`${b.mixed} mixed`);
  if (b.negative) parts.push(`${b.negative} negative`);
  return parts.join(', ');
}

/**
 * @param {object} p {show, score, tierId, tierLabel, reviewCount, breakdown}
 * @returns {{twitter, bluesky, threads, instagram, facebook, altText}}
 */
function buildCaptions(p) {
  const { show } = p;
  // X and Bluesky first drop the lead-in, then shorten the title; never the numbers.
  const sentence = (title, withLead = true) =>
    `${withLead ? `${TIER_LEAD[p.tierId] || 'The reviews are in.'} ` : ''}${title} has a Critic Score of ${p.score} (${p.tierLabel}) from ${p.reviewCount} critics' reviews.`;
  const title = show.title;
  const bd = breakdownLine(p.breakdown);
  const long = `${sentence(title)}${bd ? `\n\nThe tally: ${bd}.` : ''}`;
  const alt = `${title} poster with its Critic Score of ${p.score} out of 100, rated ${p.tierLabel}${bd ? `. Critics: ${bd}` : ''}.`;

  const withUrl = (text, network) => `${text}\n\n${showUrl(show, network)}`;
  const fitShort = (network) => {
    const url = showUrl(show, network);
    const budget = Math.min(SHORT_BUDGET, LIMITS[network]) - url.length - 2;
    let t = sentence(title);
    if (t.length > budget) t = sentence(title, false);
    if (t.length > budget) {
      const room = Math.max(12, title.length - (t.length - budget) - 1);
      t = sentence(`${title.slice(0, room).replace(/[\s,:;–-]+\S*$/, '')}…`, false);
    }
    return `${t}\n\n${url}`;
  };

  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: withUrl(long, 'threads'),
    // Instagram captions cannot carry live links; point at the site by name.
    instagram: `${long}\n\nFull reviews: ${MARKETS[show.category].domain}${showPath(show)} (link in bio)\n\n${hashtagLine(show)}`,
    facebook: withUrl(long, 'facebook'),
    altText: alt,
  };
}

module.exports = { buildCaptions, showUrl, postMarkers, LIMITS };
