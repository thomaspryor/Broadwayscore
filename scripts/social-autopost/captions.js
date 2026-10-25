/**
 * Post text per network. Templates, not an LLM: every number comes straight
 * from the site's data, and nothing can be invented.
 *
 * Limits (Buffer, developers.buffer.com/guides/character-limits): X free 280,
 * Bluesky 300, Threads 500, Instagram 2,196, Facebook 5,000. X counts any URL
 * as 23 characters; we budget the full URL length so Bluesky is safe too.
 */

const { MARKETS } = require('./config');

const LIMITS = { twitter: 280, bluesky: 300, threads: 500, instagram: 2196, facebook: 5000 };
const SHORT_BUDGET = 270; // fits X and Bluesky with margin

function showPath(show) {
  return `/show/${show.slug || show.id}`;
}

function showUrl(show, network) {
  return `https://${MARKETS[show.category].domain}${showPath(show)}?utm_source=${network}&utm_medium=social&utm_campaign=autopost`;
}

/**
 * Strings every caption of this post contains on every network: the show path
 * and the event phrase. buffer.js findExistingPost matches on them to avoid
 * posting the same event twice.
 */
function postMarkers(type, show) {
  return [showPath(show), type === 'score' ? 'has a Critic Score of' : 'opens tonight'];
}

/** "at the Palace Theatre" / "at The Public Theater" / "at Shakespeare's Globe" */
function atVenue(venue) {
  if (!venue) return '';
  const v = String(venue).trim();
  if (/^the\s/i.test(v)) return `at ${v}`;
  if (/(theat(er|re)|playhouse|hall|centre|center|warehouse|house|armory|stage)$/i.test(v)) return `at the ${v}`;
  return `at ${v}`;
}

const TIER_LEAD = {
  'must-see': 'The critics are raving.',
  recommended: 'Critics recommend it.',
  'worth-seeing': 'Worth seeing, say the critics.',
  skippable: 'Critics are mixed.',
  'stay-away': 'Critics are not sold.',
};

function hashtagLine(show) {
  const tags = MARKETS[show.category].hashtags;
  return tags.map(t => `#${t}`).join(' ');
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
 * @param {object} p {type, show, score, tierId, tierLabel, reviewCount, breakdown}
 * @returns {{twitter, bluesky, threads, instagram, facebook, altText}}
 */
function buildCaptions(p) {
  const { show } = p;
  const title = show.title;
  let short, long, alt;

  if (p.type === 'score') {
    const lead = TIER_LEAD[p.tierId] || '';
    const core = `${title} has a Critic Score of ${p.score} (${p.tierLabel}) from ${p.reviewCount} critics' reviews.`;
    short = `${lead} ${core}`.trim();
    const bd = breakdownLine(p.breakdown);
    long = `${short}${bd ? `\n\nThe tally: ${bd}.` : ''}`;
    alt = `${title} key art with its Critic Score of ${p.score} out of 100, rated ${p.tierLabel}, from ${p.reviewCount} critics' reviews.`;
  } else {
    short = `${title} opens tonight ${atVenue(show.venue)}. We'll have the Critic Score once the reviews are in.`.replace(/\s+/g, ' ');
    long = short;
    alt = `${title} key art. Opening tonight ${atVenue(show.venue)}.`;
  }

  const withUrl = (text, network) => `${text}\n\n${showUrl(show, network)}`;
  const fitShort = (network) => {
    const url = showUrl(show, network);
    let t = short;
    const budget = Math.min(SHORT_BUDGET, LIMITS[network]) - url.length - 2;
    if (t.length > budget) t = `${t.slice(0, budget - 1).replace(/\s+\S*$/, '')}…`;
    return `${t}\n\n${url}`;
  };

  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: withUrl(long, 'threads'),
    // Instagram captions cannot carry live links; point at the site by name.
    instagram: `${long}\n\nFull reviews: ${MARKETS[show.category].domain}${showPath(show)} (link in bio)\n\n${hashtagLine(show)} #Theatre`,
    facebook: withUrl(long, 'facebook'),
    altText: alt,
  };
}

module.exports = { buildCaptions, showUrl, postMarkers, atVenue, LIMITS };
