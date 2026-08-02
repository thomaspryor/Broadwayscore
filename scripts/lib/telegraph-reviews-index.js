/**
 * Telegraph reviews-index card parser (task #720).
 *
 * WHY THIS EXISTS
 * The Telegraph writes editorial headlines and editorial slugs: its Tao of Glass
 * review is headlined "This love letter to Philip Glass is full of wonder" at
 * /music/classical-music/this-love-letter-to-philip-glass/. Neither the headline
 * nor the URL slug contains the show title, so EVERY title-anchored discovery arm
 * misses it:
 *   - the per-outlet SERP arm's query (`site:telegraph.co.uk "Tao of Glass"
 *     West End review 2026`) doesn't return it in the top 10 at all, and even the
 *     lean query that does return it at rank 1 is then dropped by
 *     urlLooksLikeReview() / titleHasShow in url-discovery.js;
 *   - the old site-search config searched /search/?q=... and only matched
 *     href="…/theatre/…", which this /music/ URL can never satisfy.
 * Result: the review stayed invisible until a WET/TR roundup happened to cite it.
 *
 * THE FIX
 * https://www.telegraph.co.uk/theatre/reviews/ is a plain SSR index of recent
 * Telegraph theatre reviews (it carries theatre reviews filed under /music/ too —
 * verified: the Tao of Glass card is on it). Each card exposes the headline link,
 * the standfirst, the star rating, the byline and the publish time in stable
 * data-test attributes. The standfirst reliably names the show even when the
 * headline doesn't, so we title-match on headline + standfirst instead of the URL.
 *
 * Same shape as the Variety /legit/reviews/ and Parterre section-page endpoints in
 * site-search-discovery.js: a fetchAndParse entry with skipUrlFilter, doing its own
 * title validation because the dispatcher's URL-slug matcher would reject every
 * Telegraph review.
 */

const INDEX_URL = 'https://www.telegraph.co.uk/theatre/reviews/';

// A structural break that still yields a HANDFUL of parseable cards is more
// dangerous than one that yields zero: zero is obviously broken, three looks
// like a quiet Telegraph week. The index reliably carries 30-40 cards, so warn
// below this floor as well as at zero. (ship-check finding, task #720.)
const MIN_EXPECTED_CARDS = 12;

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8212;|&mdash;/g, '-');
}

function cleanText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize for token-sequence comparison: lowercase, diacritics folded,
 * apostrophes REMOVED (not spaced) so "Night's" and "Nights" collapse to the
 * same token, then any other punctuation becomes a separator.
 * See feedback_word_boundary_punct_titles / feedback_apostrophe_name_matching.
 */
function normalizeForPhrase(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019\u2018`\u00b4]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Token-sequence containment: does `phrase` appear in `hay` on whole-token
 * boundaries? Both args must already be normalized. Padding with spaces turns
 * substring containment into token-sequence containment, so "tru" no longer
 * matches inside "the truth" \u2014 a real false positive this parser produced
 * against the live corpus before the ship-check fix (task #720).
 */
function containsPhrase(hay, phrase) {
  if (!hay || !phrase) return false;
  return ` ${hay} `.includes(` ${phrase} `);
}

// Leading articles are dropped by some Telegraph headlines and kept by others.
const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

/**
 * The title strings worth testing against a card: the full title, the part
 * before a " - " venue/subtitle suffix, and each of those minus a leading
 * article. All normalized; empties and dupes removed.
 */
function titleVariants(showTitle, hay = null) {
  const raw = String(showTitle || '');
  const out = new Set();
  const add = (t) => {
    const n = normalizeForPhrase(t);
    if (n) out.add(n);
    const stripped = n.replace(LEADING_ARTICLE, '').trim();
    if (stripped) out.add(stripped);
  };
  add(raw);

  // " - <suffix>" titles ("A Midsummer Night's Dream - Globe", "Cyrano - The
  // Musical") are how the corpus distinguishes SIMULTANEOUS productions of the
  // same play. Offering the bare pre-suffix title as a variant throws that
  // distinction away: the Regent's Park Midsummer card then matched the Globe
  // AND Unicorn entries too, and a Drury Lane JCS entry matched the Palladium
  // card. So the bare variant only counts when the suffix is ALSO corroborated
  // in the card (`hay`). With no hay to check against, the bare variant is
  // withheld — fail closed on the ambiguous case.
  if (raw.includes(' - ')) {
    const [primary, ...rest] = raw.split(' - ');
    const suffixTokens = normalizeForPhrase(rest.join(' ')).split(' ').filter(t => t.length > 3);
    const corroborated = hay !== null
      && suffixTokens.length > 0
      && suffixTokens.some(t => containsPhrase(hay, t));
    if (corroborated) add(primary);
  }

  return [...out].filter(t => t.length >= 3);
}

/** Meaningful token count after dropping the leading article. */
function meaningfulTokenCount(showTitle) {
  const n = normalizeForPhrase(showTitle).replace(LEADING_ARTICLE, '').trim();
  return n ? n.split(' ').length : 0;
}

/**
 * Split the index HTML into per-review card blocks and pull the fields we need.
 *
 * Returns [{ url, headline, standfirst, rating, criticName, publishDate }].
 * `url` is absolute; every other field may be null when the card omits it.
 */
function parseTelegraphReviewCards(html) {
  const cards = [];
  if (!html || typeof html !== 'string') return cards;

  // Cards are non-nested <article data-test="card"> … </article> blocks.
  const articleRe = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const block = m[1];

    // Headline link — data-test="list-headline-link" is the card's canonical
    // article link (byline/author links carry rel="author" and are skipped).
    const linkMatch = block.match(/<a\b[^>]*data-test=["']list-headline-link["'][^>]*href=["']([^"']+)["']/i)
      || block.match(/href=["']([^"']+)["'][^>]*data-test=["']list-headline-link["']/i);
    if (!linkMatch) continue;

    let href = decodeEntities(linkMatch[1]).trim();
    if (!href || href.startsWith('#')) continue;
    let url;
    try {
      url = new URL(href, 'https://www.telegraph.co.uk').toString();
    } catch { continue; }
    if (!/(^|\.)telegraph\.co\.uk$/i.test(new URL(url).hostname)) continue;

    const headlineMatch = block.match(/data-test="headline"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/i)
      || block.match(/data-test="headline"[^>]*>([\s\S]*?)<\/span>/i);
    const standfirstMatch = block.match(/data-test="standfirst"[^>]*>([\s\S]*?)<\/p>/i);
    const ratingMatch = block.match(/data-test="review-rating-text"[^>]*>([\s\S]*?)<\/p>/i);
    const criticMatch = block.match(/data-test="author-name"[^>]*>([\s\S]*?)<\/span>/i);
    const dateMatch = block.match(/<time\b[^>]*datetime="([^"]+)"/i);

    cards.push({
      url,
      headline: headlineMatch ? cleanText(headlineMatch[1]) : null,
      standfirst: standfirstMatch ? cleanText(standfirstMatch[1]) : null,
      rating: ratingMatch ? cleanText(ratingMatch[1]) : null,
      criticName: criticMatch ? cleanText(criticMatch[1]) : null,
      publishDate: dateMatch ? dateMatch[1] : null,
    });
  }
  return cards;
}

// Grace either side of the run. Press night reviews can land a few days before
// the official opening, and late/weekend write-ups a few weeks after closing.
const RUN_GRACE_BEFORE_MS = 21 * 24 * 60 * 60 * 1000;
const RUN_GRACE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Could a review published on `card.publishDate` be about THIS production?
 *
 * Fails OPEN when either side is unknown (no card date, or no show dates) —
 * the title match still has to hold, and under-collecting on missing metadata
 * would silently drop legitimate reviews for sparsely-populated shows.
 */
function isCardWithinRun(card, showInfo) {
  if (!card || !card.publishDate || !showInfo) return true;
  const published = Date.parse(card.publishDate);
  if (Number.isNaN(published)) return true;

  const startRaw = showInfo.previewsStartDate || showInfo.openingDate;
  const start = startRaw ? Date.parse(startRaw) : NaN;
  if (!Number.isNaN(start) && published < start - RUN_GRACE_BEFORE_MS) return false;

  const end = showInfo.closingDate ? Date.parse(showInfo.closingDate) : NaN;
  if (!Number.isNaN(end) && published > end + RUN_GRACE_AFTER_MS) return false;

  return true;
}

/**
 * Does this card name the show?
 *
 * Haystack = URL path + headline + standfirst. The URL path is included because
 * the Telegraph's slug carries the title whenever the headline doesn't
 * (midsummer-nights-dream-review-regents-park), and the standfirst carries it
 * whenever the slug doesn't (the Tao of Glass case this whole module exists for).
 *
 * Matching is TOKEN-SEQUENCE containment of the title (or its pre-" - " /
 * article-stripped variants), never substring. Substring matching produced real
 * false positives against the live corpus: "Tru" inside "the truth".
 *
 * ONE-WORD TITLES ARE GATED. Sweeping all 2,800 corpus titles against a real
 * 38-card capture of this page, bare one-word matching attached the WRONG review
 * to: Hair, Plenty, Sting, Local, Wonder ("...is full of wonder"), and The Bridge
 * (the Bridge Theatre venue in another show's slug). So a one-word title must
 * ALSO carry a disambiguator — a venue token or a cast/creative surname — in the
 * card, reusing url-discovery's isGenericShowTitle/hasDisambiguator (the Sting
 * 2026 incident helpers).
 *
 * This is STRICTER than url-discovery's use of the same helpers, which accepts a
 * bare match when the show has no cast/creative to gate on. url-discovery is
 * already scoped by a domain- and title-restricted SERP query; this scans 38
 * arbitrary cards, so an ungateable one-word title is rejected rather than
 * guessed. Deliberate under-collection over silent misattribution.
 *
 * NOTE — matched against the card's OWN fields only. Every telegraph.co.uk page
 * carries a "more from Theatre" rail naming other shows; a page-level matcher
 * would attach every review to every show.
 *
 * @param {Object} card - from parseTelegraphReviewCards
 * @param {string} showTitle
 * @param {Object} [showInfo] - getShowInfo() shape ({venue, cast, creativeNames,
 *   leadActor}). Required to accept a one-word title; without it, one-word
 *   titles fail closed.
 */
function cardMatchesShow(card, showTitle, showInfo = null) {
  if (!card || !showTitle) return false;

  let urlPath = '';
  try { urlPath = new URL(card.url).pathname; } catch { /* card.url may be absent */ }
  const rawText = `${urlPath} ${card.headline || ''} ${card.standfirst || ''}`;
  const hay = normalizeForPhrase(rawText);
  if (!hay) return false;

  const matched = titleVariants(showTitle, hay).filter(v => containsPhrase(hay, v));
  if (matched.length === 0) return false;

  // PRODUCTION-WINDOW GATE. The index is a rolling window of CURRENT reviews, so
  // a card can only belong to a production that was actually running when it was
  // published. Without this, every same-title entry in the corpus claims the same
  // card — a 2026 Cherry Orchard review matched the 2012 and 1993 productions too.
  if (!isCardWithinRun(card, showInfo)) return false;

  // The gate keys on the variant that ACTUALLY matched, not on the full title,
  // and counts MEANINGFUL tokens (leading article stripped). Keying it on the
  // full title let "Midnight - A New Original Musical by Todrick Hall" match
  // "midnight at the never get" (a different show); counting raw tokens let
  // "The Bridge" match "…at the Bridge Theatre" in another show's standfirst.
  if (matched.some(v => meaningfulTokenCount(v) > 1)) return true;

  // Only a one-word variant matched. Two ways through:
  const matchedWord = matched[0];
  const slug = normalizeForPhrase(urlPath);

  // (a) The word is in the Telegraph's own URL SLUG. An editor who slugs a
  //     review "muddled-trainspotting-musical-review" is writing about
  //     Trainspotting. EXCEPT when the word is immediately followed by
  //     "theatre"/"theater" — then it's a VENUE, not the subject:
  //     "the-oresteia-BRIDGE-THEATRE-review" is the Oresteia at the Bridge
  //     Theatre, not the show called The Bridge.
  if (containsPhrase(slug, matchedWord)
      && !containsPhrase(slug, `${matchedWord} theatre`)
      && !containsPhrase(slug, `${matchedWord} theater`)) {
    return true;
  }

  // (b) Body-text-only match: require a venue/person disambiguator that is NOT
  //     the title word itself. Without stripping it the check is circular — the
  //     same "bridge" token would be both the match and its own proof.
  if (!showInfo) return false;
  const { hasDisambiguator } = require('./url-discovery');
  const residual = normalizeForPhrase(rawText)
    .split(' ').filter(tok => tok !== matchedWord).join(' ');
  return hasDisambiguator(residual, showInfo);
}

/**
 * Filter parsed cards down to the ones naming `showTitle`.
 *
 * AMBIGUITY GUARD: a show should have at most ONE review on a rolling ~38-card
 * index. Two or more matches means the title is colliding with unrelated card
 * text (measured: "Summer" matched both a Summer Holiday review and a Much Ado
 * review), and we cannot tell which — if either — is right. Return nothing
 * rather than attach a coin-flip. Deliberate under-collection over silent
 * misattribution; the roundup/SERP arms still cover the show.
 */
function matchTelegraphCards(cards, showTitle, showInfo = null) {
  const hits = (cards || []).filter(c => cardMatchesShow(c, showTitle, showInfo));
  return hits.length > 1 ? [] : hits;
}

/**
 * Fetch the Telegraph reviews index and return review URLs for `showTitle`.
 * `fetchImpl` is injected by site-search-discovery.js (its fetchSSR wrapper) so
 * this module stays fetch-agnostic and unit-testable.
 */
// In-process card cache. The index is the SAME page for every show, and the
// poller runs this endpoint once per polled show per cycle (measured: ~29 shows
// in the 21-day orchestrator window), so without this it would re-fetch the
// identical page 29 times a cycle. TTL keeps a long-lived process from serving
// a stale index on opening night. Reset via _resetTelegraphIndexCache() in tests.
const INDEX_CACHE_TTL_MS = 10 * 60 * 1000;
let _indexCache = null; // { at: epochMs, cards: [...] }

function _resetTelegraphIndexCache() { _indexCache = null; }

async function discoverTelegraphReviewUrls(showTitle, fetchImpl, log = console.warn, showInfo = null) {
  const nowMs = Date.now();
  if (_indexCache && (nowMs - _indexCache.at) < INDEX_CACHE_TTL_MS) {
    return [...new Set(matchTelegraphCards(_indexCache.cards, showTitle, showInfo).map(c => c.url))];
  }
  const html = await fetchImpl(INDEX_URL);
  const cards = parseTelegraphReviewCards(html);
  if (cards.length === 0) {
    // Zero-cards guard: same rationale as the Variety endpoint — a silent zero
    // here looks identical to "Telegraph reviewed nothing", which is how a
    // structural change goes undetected for weeks. NOT cached, so a transient
    // fetch failure doesn't poison the whole cycle.
    log('    Site search [The Telegraph]: WARNING — reviews index returned 0 cards (possible structural change)');
    return [];
  }
  _indexCache = { at: nowMs, cards };
  // Count only cards that actually carry TEXT. A redesign that renamed the
  // data-test="headline"/"standfirst" attributes would still yield 38 URL-only
  // shells — full count, zero matchable content, no warning — and the Tao case
  // would regress silently. Health is about usable cards, not <article> tags.
  const usable = cards.filter(c => c.headline || c.standfirst).length;
  if (usable < MIN_EXPECTED_CARDS) {
    log(`    Site search [The Telegraph]: WARNING — reviews index parsed only ${usable} usable cards of ${cards.length} (expected >= ${MIN_EXPECTED_CARDS}; possible partial structural change)`);
  }
  const matched = matchTelegraphCards(cards, showTitle, showInfo);
  return [...new Set(matched.map(c => c.url))];
}

module.exports = {
  INDEX_URL,
  MIN_EXPECTED_CARDS,
  parseTelegraphReviewCards,
  cardMatchesShow,
  matchTelegraphCards,
  discoverTelegraphReviewUrls,
  normalizeForPhrase,
  containsPhrase,
  isCardWithinRun,
  titleVariants,
  meaningfulTokenCount,
  _resetTelegraphIndexCache,
};
