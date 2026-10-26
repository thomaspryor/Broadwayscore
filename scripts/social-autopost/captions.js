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
function showUrl(show, network, campaign = 'autopost') {
  return `https://${MARKETS[show.category].domain}${showPath(show)}?utm_source=${network}&utm_medium=social&utm_campaign=${campaign}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The show path, ending at "?" or whitespace, so /show/proof never matches /show/proof-2000. */
function pathMarker(show) {
  return new RegExp(`${escapeRe(showPath(show))}(?=[?\\s]|$)`);
}

/**
 * Patterns every caption of this post matches on every network: the show path
 * (ending at "?" or whitespace, so /show/proof never matches /show/proof-2000) and
 * the score sentence. buffer.js findExistingPost matches on them so the same post
 * is never created twice.
 */
// The score post's sentence. No other post type may use it (social-autopost.test.mjs),
// so a score post's dedupe never mistakes a brief post for itself, and the reverse.
const SCORE_SENTENCE = /has a Critic Score of \d/;

function postMarkers(show) {
  return [pathMarker(show), SCORE_SENTENCE];
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

// ---------------------------------------------------------------------------
// Brief posts (BRO-6368): one-off posts the owner asks for. Every number in them
// comes from code; the session may add one hook sentence that carries no number
// and makes no comparison (validateHook).

const CITY = { broadway: 'New York', 'off-broadway': 'New York', 'west-end': 'London', 'off-west-end': 'London' };
// The production line ("London 2024: Critic Score 85 from 26 critics" or the short
// "London 2024: 85 from 26 critics"), in every compare caption and never in a score post.
const COMPARE_SENTENCE = /\b(?:London|Broadway|Off-Broadway) \d{4}: (?:Critic Score )?\d+ from \d+ critics\b/;
const HOOK_MAX = 140;
const HOOK_BANNED = [
  [/\d/, 'a digit (numbers come only from the site data)'],
  [/[\u2013\u2014]/, 'an en or em dash'],
  [/https?:|www\.|[#@]/i, 'a link, hashtag or handle'],
  [/\b(better|worse|best|worst|higher|lower|more|less|than|beat|beats|beaten|outscor\w*|outperform\w*|improv\w*|transfer\w*|vs|versus|rank\w*|top)\b/i, 'a comparison word'],
  [/\b(delve|robust|leverage|unlock|tapestry|realm|journey|landscape|navigate|deep dive|not just|it's not|moreover|furthermore|additionally|truly|genuinely)\b/i, 'an anti-slop word'],
];

/** Problem with a hook sentence, or null when it is fine (empty is fine). */
function validateHook(hook) {
  if (hook == null || hook === '') return null;
  if (typeof hook !== 'string') return 'hook must be text';
  if (hook.length > HOOK_MAX) return `hook is ${hook.length} characters, at most ${HOOK_MAX}`;
  if (/\n/.test(hook)) return 'hook must be one line';
  for (const [re, what] of HOOK_BANNED) if (re.test(hook)) return `hook contains ${what}`;
  return null;
}

/**
 * Numbers in a caption that are not in `allowed` (links, domains and hashtags
 * are ignored). Empty means every number came from the facts.
 */
function strayNumbers(text, allowed) {
  const ok = new Set([...allowed].map(String));
  const bare = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/\S+\.com\/\S+/g, ' ').replace(/#\w+/g, ' ');
  return (bare.match(/\d+/g) || []).filter(n => !ok.has(n));
}

/** "London 2024", "Off-Broadway 2026": the city for London, the market for New York. */
const openingYear = show => String(show.openingDate || show.previewsStartDate || '').slice(0, 4);

function productionLabel(show) {
  const year = openingYear(show);
  const where = CITY[show.category] === 'London' ? 'London' : MARKETS[show.category].label;
  return year ? `${where} ${year}` : where;
}

/**
 * Markers every caption of a compare post carries: the newer show's path, the compare
 * sentence and, when known, the other production's label line ("London 2024: "), so a
 * second pair with the same newer production never adopts this pair's Buffer post.
 */
function compareMarkers(newerShow, olderLabel) {
  const out = [pathMarker(newerShow), COMPARE_SENTENCE];
  if (olderLabel) out.push(new RegExp(`(?:^|\\n)${olderLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
  return out;
}

/**
 * Compare post captions.
 * @param {object} p { newer, older, hook } where newer/older = { show, score, reviewCount, soFar }
 * @returns {{twitter, bluesky, threads, instagram, facebook, altText}}
 */
const NUMBER_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/**
 * The line that warns two productions' scores are not like for like, when they opened
 * in different years or markets ("Two years apart, in different cities, with different
 * critics, ..."). In words, never digits, so it cannot pass for a number from the data.
 * Null when both opened the same year in the same market.
 */
function compareCaveat(newerShow, olderShow, { short = false } = {}) {
  const [a, b] = [openingYear(newerShow), openingYear(olderShow)].map(Number);
  const years = a && b ? Math.abs(a - b) : 0;
  const when = years === 0 ? null : years === 1 ? 'a year apart'
    : years < NUMBER_WORDS.length ? `${NUMBER_WORDS[years]} years apart` : 'decades apart';
  const where = CITY[newerShow.category] !== CITY[olderShow.category] ? 'cities'
    : newerShow.category !== olderShow.category ? 'markets' : null;
  if (!when && !where) return null;
  const cap = t => `${t[0].toUpperCase()}${t.slice(1)}`;
  // Short form for X and Bluesky: "Two years apart, different cities and critics."
  if (short) return `${cap([when, where ? `different ${where} and critics` : 'different critics'].filter(Boolean).join(', '))}.`;
  const s = [when, where && `in different ${where}`, 'with different critics'].filter(Boolean).join(', ');
  return `${cap(s)}, so the scores aren't a like-for-like comparison.`;
}

function buildCompareCaptions(p) {
  const { newer, older } = p;
  const lead = title => `${title} was also reviewed in ${CITY[older.show.category]}.`;
  const fact = d => `${productionLabel(d.show)}: Critic Score ${d.score} from ${d.reviewCount} critics${d.soFar ? ' so far' : ''}.`;
  const facts = `${fact(newer)}\n${fact(older)}`;
  const shortFact = d => `${productionLabel(d.show)}: ${d.score} from ${d.reviewCount} critics${d.soFar ? ' so far' : ''}`;
  const hook = p.hook ? `${p.hook.trim()}\n\n` : '';
  const title = newer.show.title;
  const caveat = compareCaveat(newer.show, older.show);
  const shortCaveat = compareCaveat(newer.show, older.show, { short: true });
  const long = `${hook}${lead(title)}\n\n${facts}${caveat ? `\n\n${caveat}` : ''}`;
  const links = network => `${productionLabel(newer.show)} reviews: ${showUrl(newer.show, network, 'brief')}\n${productionLabel(older.show)} reviews: ${showUrl(older.show, network, 'brief')}`;

  // X and Bluesky carry the newer show's link only, in a compact form: drop the hook,
  // then the full caveat for the short one, then the caveat, then shorten the title,
  // never the numbers or the link. X counts any link as 23 characters
  // (t.co); Bluesky counts it in full.
  const fitShort = network => {
    const url = showUrl(newer.show, network, 'brief');
    const linkCost = network === 'twitter' ? 23 : url.length;
    const budget = LIMITS[network] - 10 - linkCost - 1;
    const body = (t, withHook, line = caveat) => `${withHook ? hook : ''}${lead(t)}\n${shortFact(newer)}\n${shortFact(older)}${line ? `\n${line}` : ''}`;
    let t = body(title, true);
    if (t.length > budget) t = body(title, false);
    if (t.length > budget) t = body(title, false, shortCaveat);
    if (t.length > budget) t = body(title, false, null);
    if (t.length > budget) {
      const room = Math.max(12, title.length - (t.length - budget) - 1);
      t = body(`${title.slice(0, room).replace(/[\s,:;–-]+\S*$/, '')}…`, false, null);
    }
    return `${t}\n${url}`;
  };
  // Threads allows 500 characters, links included: drop the hook, then the older show's link.
  const fitThreads = () => {
    const noHook = `${lead(title)}\n\n${facts}${caveat ? `\n\n${caveat}` : ''}`;
    const tries = [`${long}\n\n${links('threads')}`, `${noHook}\n\n${links('threads')}`,
      `${noHook}\n\n${showUrl(newer.show, 'threads', 'brief')}`, `${lead(title)}\n\n${facts}\n\n${showUrl(newer.show, 'threads', 'brief')}`];
    return tries.find(t => t.length <= LIMITS.threads) || tries[tries.length - 1];
  };
  const tags = [...new Set([...MARKETS[newer.show.category].hashtags, ...MARKETS[older.show.category].hashtags, 'Theatre'])].map(t => `#${t}`).join(' ');
  const site = d => `${MARKETS[d.show.category].domain}${showPath(d.show)}`;
  const altFact = d => `${productionLabel(d.show)}, ${d.score} from ${d.reviewCount} critics${d.soFar ? ' so far' : ''}`;

  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: fitThreads(),
    instagram: `${long}\n\nFull reviews: ${site(newer)} and ${site(older)} (link in bio)\n\n${tags}`,
    facebook: `${long}\n\n${links('facebook')}`,
    altText: `Critic Scores for ${title}: ${altFact(newer)}; ${altFact(older)}.`,
  };
}

module.exports = {
  buildCaptions, showUrl, postMarkers, LIMITS,
  buildCompareCaptions, compareCaveat, compareMarkers, validateHook, strayNumbers, productionLabel, pathMarker, CITY, SCORE_SENTENCE, COMPARE_SENTENCE,
};
