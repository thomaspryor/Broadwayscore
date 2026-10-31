/**
 * Post text per network. Templates, not an LLM: every number comes straight
 * from the site's data, and nothing can be invented.
 *
 * Limits (Buffer, developers.buffer.com/guides/character-limits): X free 280,
 * Bluesky 300, Threads 500, Instagram 2,196, Facebook 5,000. X counts each URL
 * as 23 characters; other networks use the full URL length.
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


// ---------------------------------------------------------------------------
// Voice (BRO-6417, scripts/social-autopost/VOICE.md): every post informs, then asks
// an open question. The question is built here from the facts, never written by a
// session, so it cannot misstate a number or a direction. On X and Bluesky it
// outranks the caveat and the lead-in: those go first, then the title is shortened,
// and the question is dropped only if nothing else is left to cut.

const cap1 = t => `${t[0].toUpperCase()}${t.slice(1)}`;
const an = n => (/^8/.test(String(n)) || n === 11 || n === 18 ? 'an' : 'a');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Shorten a title to at most `max` characters at a word boundary. */
const clipTitle = (t, max) => {
  if (t.length <= max) return t;
  let c = t.slice(0, max - 1);
  if (/\d$/.test(c) && /^\d/.test(t.slice(max - 1))) c = c.replace(/\d+$/, ''); // never cut through a number ("1776" must not become "17")
  return `${c.replace(/[\s,:;–-]+\S*$/, '')}…`;
};
/** First attempt that fits `budget` characters, else the last one. */
const firstFit = (budget, tries) => tries.find(t => [...t].length <= budget) || tries[tries.length - 1];
/** Title lengths to try when a short caption has to give up title characters. */
const CLIPS = [60, 48, 38, 30, 24, 18, 14];

/** Critic counts the score question reads: positive side (rave + positive), mixed-or-negative side, and the total. */
function sides(b) {
  if (!b) return { pos: 0, neg: 0, total: 0 };
  const pos = (b.rave || 0) + (b.positive || 0), neg = (b.mixed || 0) + (b.negative || 0);
  return { pos, neg, total: pos + neg };
}

/**
 * The closing question of a score post: {long, short}. A divided tally (both sides at
 * least 30% of six or more reviews) asks what is behind the split; otherwise the tier
 * picks the angle. Numbers it states are rave+positive and mixed+negative (scoreAllowedNumbers).
 */
function scoreQuestion(p) {
  const { pos, neg, total } = sides(p.breakdown);
  if (total >= 6 && pos / total >= 0.3 && neg / total >= 0.3) {
    return { long: `Critics are divided: ${pos} positive, ${neg} mixed or negative. What do you think is behind the split?`, short: `${pos} positive, ${neg} mixed or negative. What's behind the split?` };
  }
  const by = {
    'must-see': { long: 'Critics are raving. What do you think makes it land so well?', short: 'What makes it land so well with critics?' },
    recommended: { long: 'What would convince you to book it, and what might hold you back?', short: 'What would convince you to book it?' },
    'worth-seeing': { long: 'Who do you think this one is for?', short: 'Who do you think this one is for?' },
    skippable: { long: 'What do you think is holding it back, and who might it still work for?', short: 'What is holding it back, and who might it work for?' },
    'stay-away': { long: 'What do you make of that verdict, and where do you think it went wrong?', short: 'What do you make of that verdict?' },
  };
  return by[p.tierId] || by['worth-seeing'];
}

/** Numbers a score caption may carry: the facts and the two tally sides the question states. */
function scoreAllowedNumbers(p) {
  const b = p.breakdown || {}, sd = sides(b);
  return [p.score, p.reviewCount, b.rave, b.positive, b.mixed, b.negative, sd.pos, sd.neg, 100, ...(String(p.show.title).match(/\d+/g) || [])].filter(n => n != null);
}

/**
 * @param {object} p {show, score, tierId, tierLabel, reviewCount, breakdown}
 * @returns {{twitter, bluesky, threads, instagram, facebook, altText}}
 */
function buildCaptions(p) {
  const { show } = p;
  // Never the numbers.
  const sentence = (title, withLead = true) =>
    `${withLead ? `${TIER_LEAD[p.tierId] || 'The reviews are in.'} ` : ''}${title} has a Critic Score of ${p.score} (${p.tierLabel}) from ${p.reviewCount} critics' reviews.`;
  const title = show.title;
  const bd = breakdownLine(p.breakdown);
  const q = scoreQuestion(p);
  const long = `${sentence(title)}${bd ? `\n\nThe tally: ${bd}.` : ''}\n\n${q.long}`;
  const alt = `${title} poster with its Critic Score of ${p.score} out of 100, rated ${p.tierLabel}${bd ? `. Critics: ${bd}` : ''}.`;

  const withUrl = (text, network) => `${text}\n\n${showUrl(show, network)}`;
  // Order: drop the lead-in, then shorten the title, then (only if nothing else is left) the question.
  const fitShort = (network) => {
    const url = showUrl(show, network);
    const budget = Math.min(SHORT_BUDGET, LIMITS[network]) - (network === 'twitter' ? 23 : url.length) - 2;
    const body = (t, lead, ask) => `${sentence(t, lead)}${ask ? `\n\n${ask}` : ''}`;
    const t = firstFit(budget, [body(title, true, q.short), body(title, false, q.short),
      ...CLIPS.map(n => body(clipTitle(title, n), false, q.short)), body(clipTitle(title, 14), false, null)]);
    return `${t}\n\n${url}`;
  };

  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: withUrl(long.length + showUrl(show, 'threads').length + 2 <= LIMITS.threads ? long : `${sentence(title, false)}\n\n${q.short}`, 'threads'),
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

/**
 * Closing question of a compare post, from the direction and size of the gap
 * (the gap is allowed in briefs.allowedNumbers as `delta`). Within 3 points the angle is the agreement.
 */
function compareQuestion(newer, older) {
  const gap = Math.abs(newer.score - older.score);
  if (gap <= 3) return { long: 'Same show, two cities, and the critics largely agree. What do you think carried over so well?', short: 'Two cities, critics agree. What carried over?', tiny: 'What carried over?' };
  const warmer = newer.score > older.score ? newer : older, city = CITY[warmer.show.category];
  return { long: `Same show, two cities, ${an(gap)} ${gap}-point gap. Why do you think ${city} critics warmed to it more?`, short: `${cap1(an(gap))} ${gap}-point gap. Why did ${city} critics warm to it more?`, tiny: `Why did ${city} critics warm to it more?` };
}

function buildCompareCaptions(p) {
  const { newer, older } = p;
  const q = compareQuestion(newer, older);
  const lead = title => `${title} was also reviewed in ${CITY[older.show.category]}.`;
  const fact = d => `${productionLabel(d.show)}: Critic Score ${d.score} from ${d.reviewCount} critics${d.soFar ? ' so far' : ''}.`;
  const facts = `${fact(newer)}\n${fact(older)}`;
  const shortFact = d => `${productionLabel(d.show)}: ${d.score} from ${d.reviewCount} critics${d.soFar ? ' so far' : ''}`;
  const hook = p.hook ? `${p.hook.trim()}\n\n` : '';
  const title = newer.show.title;
  const caveat = compareCaveat(newer.show, older.show);
  const shortCaveat = compareCaveat(newer.show, older.show, { short: true });
  const long = `${hook}${lead(title)}\n\n${facts}${caveat ? `\n\n${caveat}` : ''}\n\n${q.long}`;
  const links = network => `${productionLabel(newer.show)} reviews: ${showUrl(newer.show, network, 'brief')}\n${productionLabel(older.show)} reviews: ${showUrl(older.show, network, 'brief')}`;

  // X and Bluesky carry the newer show's link only. Fit order: drop the hook, then the
  // caveat (full, short, none), then shorten the title; the question goes last, and the
  // numbers and the link never. X counts any link as 23 characters (t.co); Bluesky in full.
  const fitShort = network => {
    const url = showUrl(newer.show, network, 'brief');
    const linkCost = network === 'twitter' ? 23 : url.length;
    const budget = LIMITS[network] - 4 - linkCost - 1;
    // bare: the lead-in sentence shrinks to the title alone (the production labels below it say where).
    const body = (t, { withHook = false, line = null, ask = q.long, bare = false } = {}) =>
      `${withHook ? hook : ''}${bare ? t : lead(t)}\n${shortFact(newer)}\n${shortFact(older)}${line ? `\n${line}` : ''}${ask ? `\n${ask}` : ''}`;
    const t = firstFit(budget, [
      body(title, { withHook: true, line: caveat }), body(title, { line: caveat }), body(title, { line: shortCaveat }),
      body(title), body(title, { ask: q.short }),
      body(title, { ask: q.short, bare: true }), body(title, { ask: q.tiny, bare: true }),
      ...CLIPS.map(n => body(clipTitle(title, n), { ask: q.short, bare: true })),
      body(clipTitle(title, 14), { ask: null }),
    ]);
    return `${t}\n${url}`;
  };
  // Threads allows 500 characters, links included: drop the hook, then the older show's link, then the caveat.
  const fitThreads = () => {
    const noHook = `${lead(title)}\n\n${facts}${caveat ? `\n\n${caveat}` : ''}\n\n${q.long}`;
    const bare = `${lead(title)}\n\n${facts}\n\n${q.long}`;
    const tries = [`${long}\n\n${links('threads')}`, `${noHook}\n\n${links('threads')}`,
      `${noHook}\n\n${showUrl(newer.show, 'threads', 'brief')}`, `${bare}\n\n${showUrl(newer.show, 'threads', 'brief')}`,
      `${lead(title)}\n\n${facts}\n\n${showUrl(newer.show, 'threads', 'brief')}`];
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

// ---------------------------------------------------------------------------
// Weekly roundup and closing soon (BRO-6413). Like every caption here these are
// templates over the site's numbers; the only words are fixed.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 22" from a YYYY-MM-DD string (no time zone involved). */
const monthDay = ymd => `${MONTHS[+String(ymd).slice(5, 7) - 1]} ${+String(ymd).slice(8, 10)}`;

// The roundup header and the closing sentence. No other post type may use them
// (social-autopost.test.mjs), and neither matches SCORE_SENTENCE or COMPARE_SENTENCE.
const ROUNDUP_SENTENCE = /New openings, [A-Z][a-z]{2} \d{1,2} to [A-Z][a-z]{2} \d{1,2}, Critic Scores:/;
const CLOSING_SENTENCE = / closes [A-Z][a-z]{2} \d{1,2}, with a Critic Score of \d/;

const SET_DOMAIN = { broadway: 'broadwayscorecard.com', 'west-end': 'westendscorecard.com' };
const rootUrl = (set, network) => `https://${SET_DOMAIN[set]}/?utm_source=${network}&utm_medium=social&utm_campaign=roundup`;

/** Header line for a roundup covering the opening days first..last (YYYY-MM-DD). */
const roundupHeader = (first, last) => `New openings, ${monthDay(first)} to ${monthDay(last)}, Critic Scores:`;

/** Patterns every caption of this roundup matches (buffer.js findExistingPost). */
function roundupMarkers(first, last, set) {
  // The set's domain tells the Broadway and West End roundups of one week apart (they share a header).
  return [ROUNDUP_SENTENCE, new RegExp(escapeRe(roundupHeader(first, last))), new RegExp(escapeRe(SET_DOMAIN[set]))];
}

/**
 * Roundup captions. p: { set, first, last, rows: [{title, category, score, tierLabel}], more }
 * rows are the ones on the card (best score first); more = openings with a score that
 * did not fit (or have no poster yet). The score is the rounded badge number.
 */
function roundupQuestion(p) {
  const top = p.rows[0];
  return { long: `${top.title} leads at ${top.score}. Which of these are you booking?`, short: 'Which of these are you booking?' };
}

function buildRoundupCaptions(p) {
  const rq = roundupQuestion(p);
  const header = roundupHeader(p.first, p.last);
  const mixed = new Set(p.rows.map(r => r.category)).size > 1;
  const tag = r => (mixed ? ` (${MARKETS[r.category].label})` : '');
  const line = (r, tier) => `${r.title}${tag(r)}: ${r.score}${tier ? ` (${r.tierLabel})` : ''}`;
  // Long form: every row with its tier word; Threads (500) drops the tier words, then trailing rows (never fewer than two).
  const longText = (n, tier) => {
    const cut = p.rows.length - n + p.more;
    return `${header}\n\n${p.rows.slice(0, n).map(r => line(r, tier)).join('\n')}${cut > 0 ? `\nPlus ${cut} more on the site.` : ''}`;
  };
  const fitLong = (network, tail) => {
    for (let n = p.rows.length; n >= Math.min(2, p.rows.length); n--) {
      for (const tier of [true, false]) {
        const text = `${longText(n, tier)}\n\n${rq.long}${tail}`;
        if ([...text].length <= LIMITS[network]) return text;
      }
    }
    return `${longText(Math.min(2, p.rows.length), false)}\n\n${rq.short}${tail}`;
  };
  const long = `${longText(p.rows.length, true)}\n\n${rq.long}`;
  const domain = SET_DOMAIN[p.set];
  const tags = [...new Set([...p.rows.flatMap(r => MARKETS[r.category].hashtags), 'Theatre'])].map(t => `#${t}`).join(' ');

  // X and Bluesky: all rows if they fit, else the best rows that do (never fewer than two); the
  // question is kept in its short form before a row goes, and never the numbers.
  const fitShort = network => {
    const url = rootUrl(p.set, network);
    const budget = Math.min(SHORT_BUDGET, LIMITS[network]) - (network === 'twitter' ? 23 : url.length) - 2;
    const text = (n, ask, clip = Infinity) => {
      const cut = p.rows.length - n + p.more;
      return `${header}\n${p.rows.slice(0, n).map(r => line({ ...r, title: clipTitle(r.title, clip) }, false)).join('\n')}${cut > 0 ? `\nPlus ${cut} more on the site.` : ''}\n\n${ask}`;
    };
    const tries = [];
    for (let n = p.rows.length; n >= Math.min(2, p.rows.length); n--) tries.push(text(n, rq.long), text(n, rq.short));
    // Then shorter titles (the question outranks them), all rows first.
    for (const clip of [36, 28, 22, 16]) for (let n = p.rows.length; n >= Math.min(2, p.rows.length); n--) tries.push(text(n, rq.short, clip));
    // Last resort: two rows and no question, so the numbers and the link still go out.
    tries.push(text(Math.min(2, p.rows.length), '').trimEnd());
    return `${firstFit(budget, tries)}\n${url}`;
  };

  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: fitLong('threads', `\n\n${rootUrl(p.set, 'threads')}`),
    instagram: `${long}\n\nAll the reviews: ${domain} (link in bio)\n\n${tags}`,
    facebook: `${long}\n\n${rootUrl(p.set, 'facebook')}`,
    altText: `Critic Scores for the week's openings, ${monthDay(p.first)} to ${monthDay(p.last)}: ${p.rows.map(r => `${r.title} ${r.score}`).join(', ')}.`,
  };
}

/** The only numbers a roundup caption may carry: scores, the two days, the "more" count and digits in titles. */
function roundupAllowedNumbers(p) {
  return [...p.rows.flatMap(r => [r.score, ...(String(r.title).match(/\d+/g) || [])]), +p.first.slice(8), +p.last.slice(8),
    ...Array.from({ length: p.rows.length + 1 }, (_, i) => p.more + i)];
}

/** Patterns every caption of a closing-soon post matches. */
function closingMarkers(show) {
  return [pathMarker(show), CLOSING_SENTENCE];
}

/**
 * Closing-soon captions. p: {show, score, tierLabel, reviewCount, breakdown, closing (YYYY-MM-DD)}.
 */
function closingQuestion(p) {
  return { long: `Last chance: who has seen it, and does it live up to the ${p.score}?`, short: `Who has seen it, and does it live up to the ${p.score}?` };
}

function buildClosingCaptions(p) {
  const { show } = p;
  const cq = closingQuestion(p);
  const sentence = title => `${title} closes ${monthDay(p.closing)}, with a Critic Score of ${p.score} (${p.tierLabel}) from ${p.reviewCount} critics' reviews.`;
  const bd = breakdownLine(p.breakdown);
  const long = `${sentence(show.title)}${bd ? `\n\nThe tally: ${bd}.` : ''}\n\n${cq.long}`;
  const withUrl = (text, network) => `${text}\n\n${showUrl(show, network, 'closing')}`;
  // Fit order: the long question, the short one, a shorter title, and only then no question.
  const fitShort = network => {
    const url = showUrl(show, network, 'closing');
    const budget = Math.min(SHORT_BUDGET, LIMITS[network]) - (network === 'twitter' ? 23 : url.length) - 2; // X counts any link as 23
    const body = (t, ask) => `${sentence(t)}${ask ? `\n\n${ask}` : ''}`;
    const t = firstFit(budget, [body(show.title, cq.long), body(show.title, cq.short),
      ...CLIPS.map(n => body(clipTitle(show.title, n), cq.short)), body(show.title, null), body(clipTitle(show.title, 14), null)]);
    return `${t}\n\n${url}`;
  };
  return {
    twitter: fitShort('twitter'),
    bluesky: fitShort('bluesky'),
    threads: withUrl(long.length + showUrl(show, 'threads', 'closing').length + 2 <= LIMITS.threads ? long : `${sentence(show.title)}\n\n${cq.short}`, 'threads'),
    instagram: `${long}\n\nFull reviews: ${MARKETS[show.category].domain}${showPath(show)} (link in bio)\n\n${hashtagLine(show)}`,
    facebook: withUrl(long, 'facebook'),
    altText: `${show.title} poster with its Critic Score of ${p.score} out of 100, rated ${p.tierLabel}. Closing ${monthDay(p.closing)}.`,
  };
}

/** The only numbers a closing-soon caption may carry. */
function closingAllowedNumbers(p) {
  const b = p.breakdown || {};
  return [100, p.score, p.reviewCount, +p.closing.slice(8), b.rave, b.positive, b.mixed, b.negative, ...(String(p.show.title).match(/\d+/g) || [])].filter(n => n != null);
}

module.exports = {
  scoreQuestion, scoreAllowedNumbers, compareQuestion, roundupQuestion, closingQuestion,
  buildCaptions, showUrl, postMarkers, LIMITS,
  buildCompareCaptions, compareCaveat, compareMarkers, validateHook, strayNumbers, productionLabel, pathMarker, CITY, SCORE_SENTENCE, COMPARE_SENTENCE,
  monthDay, ROUNDUP_SENTENCE, CLOSING_SENTENCE, roundupHeader, roundupMarkers, buildRoundupCaptions, roundupAllowedNumbers, closingMarkers, buildClosingCaptions, closingAllowedNumbers, SET_DOMAIN,
};
