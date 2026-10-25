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
 * Patterns every caption of this post matches on every network: the show path
 * and the event phrase. buffer.js findExistingPost matches on them to avoid
 * posting the same event twice.
 */
function postMarkers(type, show) {
  const escaped = showPath(show).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The path must end at "?" or whitespace, so /show/proof never matches /show/proof-2000.
  return [new RegExp(`${escaped}(?=[?\\s]|$)`), type === 'score' ? /has a Critic Score of \d/ : /opens tonight/];
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
  // The sentence for a given title. X and Bluesky first drop the lead-in (score) or
  // the closing promise (opening), then shorten the title; never the numbers.
  const sentence = (title, withLead = true) => {
    if (p.type === 'score') {
      const lead = withLead ? TIER_LEAD[p.tierId] || '' : '';
      return `${lead} ${title} has a Critic Score of ${p.score} (${p.tierLabel}) from ${p.reviewCount} critics' reviews.`.trim();
    }
    const promise = withLead ? " We'll have the Critic Score once the reviews are in." : '';
    return `${title} opens tonight ${atVenue(show.venue)}.${promise}`.replace(/\s+/g, ' ');
  };
  const title = show.title;
  let long = sentence(title);
  let alt;
  if (p.type === 'score') {
    const bd = breakdownLine(p.breakdown);
    if (bd) long += `\n\nThe tally: ${bd}.`;
    alt = `${title} key art with its Critic Score of ${p.score} out of 100, rated ${p.tierLabel}, from ${p.reviewCount} critics' reviews.`;
  } else {
    alt = `${title} key art. Opening tonight ${atVenue(show.venue)}.`;
  }

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
    instagram: `${long}\n\nFull reviews: ${MARKETS[show.category].domain}${showPath(show)} (link in bio)\n\n${hashtagLine(show)} #Theatre`,
    facebook: withUrl(long, 'facebook'),
    altText: alt,
  };
}

module.exports = { buildCaptions, showUrl, postMarkers, atVenue, LIMITS };
