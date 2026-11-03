/**
 * Cross-show URL slug guard — single source of truth.
 *
 * Detects when a review's URL slug clearly names a DIFFERENT show than the one
 * it is filed under (e.g. an `every-brilliant-thing` URL stored in the
 * `schmigadoon-2026` directory). This is the canonical implementation; both the
 * ingest-time guard (scripts/gather-reviews.js createReviewFile) and the
 * corpus-wide audit (scripts/audit-cross-show-url.js) MUST call this — never
 * reimplement the slug comparison. Naive reimplementations repeatedly produced
 * the same false-positive classes this function already filters:
 *   - common URL-path words ("/broadway/", "/theater/") matching short slugs
 *   - same-play different-production (Romeo & Juliet revivals, Harry Potter
 *     parts, Encores! La Cage) where the play name legitimately recurs
 * Extracted verbatim from gather-reviews.js on 2026-06-23 after a BWW scrape
 * bypassed the ingest-only guard and mis-filed 11 Every Brilliant Thing reviews
 * under Schmigadoon. See memory/feedback (cross-show URL guard).
 */
const fs = require('fs');
const path = require('path');
const { foldDiacritics } = require('./title-match');
const { toDateMs } = require('./date-utils');
const { earliestShowDate } = require('./date-guard');

const DEFAULT_SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Slugs that are too generic / collision-prone to use as a cross-show signal.
const CROSS_SHOW_SLUG_EXCLUDE = new Set([
  'broadway', 'west-end', 'the-story', 'romantic-comedy', 'the-red-shoes',
  'les-miserables', 'once-in-a-lifetime', 'body-count', 'the-car-man',
  'good-night-oscar', 'the-visit', 'the-outsiders', 'the-notebook',
  // BRO-4986: "fine supporting cast" is review prose, not The Supporting Cast (1981).
  'the-supporting-cast',
]);

const _indexCache = new Map();

function yearOf(value) {
  const ms = toDateMs(value);
  return Number.isNaN(ms) ? null : new Date(ms).getUTCFullYear();
}

/**
 * {startYear, endYear} of a show's runs, from shows.json date fields only
 * (never the URL, CLAUDE.md §3). startYear is the earliest of previews,
 * opening and any priorRuns opening; endYear the latest closing, or null when
 * any run has no closingDate (an open or undated run has no known end).
 */
function showRunYears(show) {
  const starts = [yearOf(earliestShowDate(show))];
  const ends = [show.closingDate ? yearOf(show.closingDate) : null];
  for (const r of Array.isArray(show.priorRuns) ? show.priorRuns : []) {
    starts.push(yearOf(r && (r.previewsStartDate || r.openingDate)));
    ends.push(r && r.closingDate ? yearOf(r.closingDate) : null);
  }
  const s = starts.filter(y => y != null);
  return {
    startYear: s.length ? Math.min(...s) : null,
    endYear: ends.every(y => y != null) ? Math.max(...ends) : null,
  };
}

// A review can't be of a show that opened more than this many years after it
// was published, or that closed more than this many years before.
const YEARS_BEFORE_START = 1;
const YEARS_AFTER_END = 2;

/**
 * True when the review's publish year rules out `other` as the show it covers
 * (BRO-3065: a 2016 Vulture "white-rabbit-red-rabbit" review matched the 2026
 * West End run; a 2025 Hell's Kitchen review matched Knockout, 1979).
 */
function outsideRunYears(other, reviewYear) {
  if (reviewYear == null) return false;
  if (other.startYear != null && other.startYear > reviewYear + YEARS_BEFORE_START) return true;
  if (other.endYear != null && other.endYear < reviewYear - YEARS_AFTER_END) return true;
  return false;
}

// Whole hyphen-delimited run: "knockout" must not match "knockouts". No
// plural/possessive "s" either: "ambassadors-theatre" (a venue) is not
// Ambassador (1972), and no real hit in the corpus needed it (BRO-3065).
function hasSlugRun(urlPath, slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(urlPath);
}

// BroadwayWorld files regional coverage under /<region>/article/ ("oklahoma",
// "charlotte"); that section word says nothing about the show reviewed.
function stripBwwSection(hostname, urlPath) {
  if (!/(^|\.)broadwayworld\.com$/.test(hostname)) return urlPath;
  return urlPath.replace(/^\/[^/]+\/article\//, '/article/');
}

// Slug with digit runs joined ("4-48" = "448"), connectors and a leading "the" dropped.
function canonTitleSlug(slug) {
  return slug.replace(/(\d)-(?=\d)/g, '$1').replace(/-s(?=-|$)/g, '').replace(/-(?:and|the|or)(?=-)/g, '').replace(/^the-/, '');
}

// True when two title slugs are the same title once canonicalised. Author credits
// ("Mike Birbiglia: ...") are deliberately NOT absorbed: "Danny and the Deep Blue Sea"
// vs "The Deep Blue Sea" are different works, and only the vouching rule below can tell.
function sameTitleModuloCredit(a, b) {
  return canonTitleSlug(a) === canonTitleSlug(b);
}

// Canonical slug of the title left after a possessive author credit of two to
// four capitalised words ("Clifford Odets’ Waiting for Lefty" -> waiting-for-lefty,
// "Irving Berlin's White Christmas" -> white-christmas), else null. A one-word
// owner ("Hell's Kitchen", "Jake's Women") or one led by an article ("The Band's
// Visit", "A Midsummer Night's Dream") is an ordinary possessive, not a credit,
// and a remainder under 8 chars is too generic to trust.
const ARTICLE_WORDS = new Set(['A', 'An', 'The', 'Our', 'My', 'Your', 'His', 'Her', 'Their']);
function creditedTitleSlug(title) {
  const m = String(title || '').match(/^((?:[A-Z][\w.\-]*\s+){1,3}[A-Z][\w.\-]*)[’']s?\s+(.+)$/);
  if (!m || ARTICLE_WORDS.has(m[1].split(/\s+/)[0])) return null;
  const rest = canonTitleSlug(slugify(m[2]));
  return rest.length >= 8 ? rest : null;
}

/**
 * Build the {id,title,slug} index from a shows array (pure, no IO).
 */
function buildShowSlugIndex(shows) {
  const index = [];
  for (const s of shows || []) {
    const slug = slugify(s.title);
    if (slug.length >= 8 && !CROSS_SHOW_SLUG_EXCLUDE.has(slug)) {
      index.push({ id: s.id, title: s.title, slug, ...showRunYears(s) });
    }
  }
  return index;
}

/**
 * Cached slug index keyed by shows.json path.
 */
function getShowSlugIndex(showsPath = DEFAULT_SHOWS_PATH) {
  if (_indexCache.has(showsPath)) return _indexCache.get(showsPath);
  let index = [];
  try {
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = showsData.shows || showsData;
    index = buildShowSlugIndex(shows);
  } catch {}
  _indexCache.set(showsPath, index);
  return index;
}

const _genericCache = new Map();
const URL_WORD_TITLES = new Set(['broadway', 'west-end']);
/**
 * {id, title, slug, generic: true} for a show titled with a bare URL path
 * word ("Broadway"), which the index leaves out; else null.
 */
function getGenericTitleShow(showId, showsPath = DEFAULT_SHOWS_PATH) {
  if (!_genericCache.has(showsPath)) {
    const m = new Map();
    try {
      const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      for (const s of showsData.shows || showsData) {
        const slug = slugify(s.title);
        // Only titles that ARE a URL path word. Other excluded titles ("The
        // Visit": reviews say "visit-review-...-chita-rivera") keep the old
        // behaviour; widening to them flagged real reviews.
        if (URL_WORD_TITLES.has(slug)) m.set(s.id, { id: s.id, title: s.title, slug, generic: true });
      }
    } catch {}
    _genericCache.set(showsPath, m);
  }
  return _genericCache.get(showsPath).get(showId) || null;
}


const _shortCache = new Map();
/** {id, title, slug} for a show the index leaves out for a short slug (< 8 chars). */
function getShortTitleShow(showId, opts = {}) {
  if (Array.isArray(opts.shows)) {
    const s = opts.shows.find(x => x && x.id === showId);
    return s ? { id: s.id, title: s.title, slug: slugify(s.title) } : null;
  }
  const showsPath = opts.showsPath || DEFAULT_SHOWS_PATH;
  if (!_shortCache.has(showsPath)) {
    const m = new Map();
    try {
      const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      for (const s of showsData.shows || showsData) {
        const slug = slugify(s && s.title);
        if (slug.length >= 3 && slug.length < 8) m.set(s.id, { id: s.id, title: s.title, slug });
      }
    } catch {}
    _shortCache.set(showsPath, m);
  }
  return _shortCache.get(showsPath).get(showId) || null;
}

const LEAD_FILLER = new Set(['the', 'a', 'an', 'and', 'of', 'my', 'our']);
/**
 * BRO-6909: a short title ("Girls", "Vanya") is left out of the slug index, so
 * the guard was off for it and a Mean Girls tour review
 * (northwestend.com/mean-girls-liverpool-empire/) counted for Girls (Young Vic,
 * 2026). Widening the index to short titles flagged 108 corpus rows, nearly all
 * real ("august-wilsons-fences", two-show round-ups, place words). The one
 * shape that held up: every mention of this title in the URL sits inside a
 * longer show title that puts words IN FRONT of it ("mean-girls",
 * "uncle-vanya"). A trailing subtitle ("tina-the-tina-turner-musical") or a
 * credit ("August Wilson's Fences") is the same work, and one bare mention
 * anywhere in the path ("and-juliet-shaftesbury-...-romeo-and-juliet") vouches.
 * Corpus 2026-11-03 (6,183 short-title rows): flags only the Mean Girls one.
 */
function shortTitleLeftExtension(thisShow, urlPath, index, reviewYear) {
  const slug = thisShow.slug;
  // Undated: no way to tell a reused link from another show. A title whose
  // slug lost a leading symbol ("& Juliet" -> "juliet") expects words in front.
  if (reviewYear == null || /^[^a-z0-9]/i.test(String(thisShow.title || '').trim())) return null;
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const runs = [...urlPath.matchAll(new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'g'))];
  if (!runs.length) return null;
  const ownTail = new RegExp(`[’']s?\\s+${slug.split('-').join('[^a-z0-9]+')}\\W*$`, 'i');
  const longer = index.filter(o => o.id !== thisShow.id && o.slug.endsWith(`-${slug}`)
    // Playing in the review's own year, not the usual +-1/2 slack: Time Out's
    // Vanya (2023) review sits on a reused ".../uncle-vanya-20-review" link,
    // and no Uncle Vanya ran in 2023.
    && o.startYear != null && o.startYear <= reviewYear && (o.endYear == null || o.endYear >= reviewYear)
    && !ownTail.test(o.title || '')
    && !sameTitleModuloCredit(o.slug, slug)
    && o.slug.slice(0, -slug.length - 1).split('-').some(w => w.length >= 3 && !LEAD_FILLER.has(w)));
  if (!longer.length) return null;
  let owner = null;
  for (const m of runs) {
    const before = urlPath.slice(0, m.index);
    const hit = longer.find(o => {
      const prefix = o.slug.slice(0, -slug.length);
      return before.endsWith(prefix) && !/[a-z0-9]/.test(before.charAt(before.length - prefix.length - 1));
    });
    if (!hit) return null;
    owner = owner || hit;
  }
  return owner ? { matchedShowId: owner.id, matchedTitle: owner.title, showTitle: thisShow.title } : null;
}

/**
 * @param {string} showId   show the review is currently filed under
 * @param {string} url      the review URL
 * @param {object} [opts]   { showsPath, index, publishDate } — inject an index
 *   for tests; publishDate (the review's own field, any format toDateMs reads)
 *   drops candidates whose run years rule them out.
 * @returns {null | { matchedShowId, matchedTitle, showTitle }}
 */
function detectCrossShowUrlMismatch(showId, url, opts = {}) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const urlPath = stripBwwSection(parsed.hostname.toLowerCase(), parsed.pathname.toLowerCase());
    const reviewYear = opts.publishDate ? yearOf(opts.publishDate) : null;
    const index = opts.index || getShowSlugIndex(opts.showsPath || DEFAULT_SHOWS_PATH);
    let thisShow = index.find(s => s.id === showId);
    // A show whose title is itself a generic URL word ("Broadway", 1987) is
    // left out of the index, which used to switch this guard off for it
    // entirely: seven reviews of The Heart of Rock and Roll (".../the-heart-
    // of-rock-and-roll-broadway-review") sat live on Broadway (1987), BRO-4977.
    // Look such a show up anyway; its own generic slug just can't vouch.
    if (!thisShow && !opts.index) {
      const generic = getGenericTitleShow(showId, opts.showsPath || DEFAULT_SHOWS_PATH);
      if (generic) thisShow = generic;
    }
    if (!thisShow) {
      const short = getShortTitleShow(showId, opts);
      return short ? shortTitleLeftExtension(short, urlPath, index, reviewYear) : null;
    }
    const ownSlugVouches = !thisShow.generic;

    // Check if URL contains this show's slug — if yes, no mismatch
    if (ownSlugVouches && urlPath.includes(thisShow.slug)) return null;

    // Also check the show ID slug (without year/market suffix) for partial matches
    const idSlug = showId.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
    if (ownSlugVouches && idSlug.length >= 8 && urlPath.includes(idSlug)) return null;

    // Normalize connectors (and/the/or) so "romeo-and-juliet" ≈ "romeo-juliet" and
    // "school-girls-or-the-african-mean-girls-play" ≈ "school-girls-african-mean-girls-play"
    // (the URL slugs outlets build drop those connector words; BRO-4267).
    const stripConnectors = s => s.replace(/-(?:and|the|or)(?=-)/g, '');
    const idSlugNorm = stripConnectors(idSlug);
    if (idSlugNorm !== idSlug && idSlugNorm.length >= 8 && urlPath.includes(idSlugNorm)) return null;
    const slugNorm = stripConnectors(thisShow.slug);
    if (slugNorm !== thisShow.slug && slugNorm.length >= 8 && urlPath.includes(slugNorm)) return null;

    // Tokens of THIS show's title that can vouch for a URL when another show's title is
    // contained in this one (see the containment carve-out below). Generic words never vouch.
    const GENERIC_TOKENS = new Set(['and', 'the', 'or', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for',
      'play', 'musical', 'show', 'review', 'reviews', 'broadway', 'theater', 'theatre', 'london', 'west', 'end', 'new', 'live']);
    const thisTokens = new Set([...thisShow.slug.split('-'), ...idSlug.split('-')]
      .filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t)));
    // Skip common URL-path words that would false-positive on nearly every URL
    const URL_PATH_STOPWORDS = new Set(['broadway', 'musical', 'theater', 'theatre', 'review', 'reviews', 'london', 'west-end', 'off-broadway']);

    // Check if URL contains a different show's slug
    for (const other of index) {
      if (other.id === showId) continue;
      if (outsideRunYears(other, reviewYear)) continue;
      // Skip shows that share a base title with this show (same slug or prefix relationship)
      const otherIdSlug = other.id.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
      if (otherIdSlug === idSlug) continue;
      // Skip if connector-normalized slugs match (e.g., "romeo-and-juliet" ≈ "romeo-juliet")
      const otherIdSlugNorm = stripConnectors(otherIdSlug);
      if (otherIdSlugNorm === idSlugNorm) continue;
      // Skip if one show's slug is a prefix of the other (e.g., "kinky-boots" vs "kinky-boots-the-musical")
      if (thisShow.slug.startsWith(other.slug) || other.slug.startsWith(thisShow.slug)) continue;
      if (idSlug.startsWith(otherIdSlug) || otherIdSlug.startsWith(idSlug)) continue;
      // BRO-6599: the same title spelled differently ("The Old Man & the Pool" vs "...and
      // the Pool", "4.48" vs "448", a leading "The") is the same play under
      // another production id, so its slug in the URL is not a different show.
      if (sameTitleModuloCredit(thisShow.slug, other.slug)) continue;
      // An author credit on this title ("Clifford Odets’ Waiting for Lefty") over
      // another show's bare title is the same play. When that other production
      // closed before this review's year (or before this run began, if the review
      // is undated), the URL's bare title can't mean it: Waiting for Lefty
      // (regional, 2024) cost the 2026 Classic Stage run Vulture, NYSR, Theater
      // Pizzazz and Cititour on its press night. A still-running or undated
      // same-title production keeps the guard (and its reroute).
      const credited = creditedTitleSlug(thisShow.title);
      const yearNow = reviewYear != null ? reviewYear : thisShow.startYear;
      if (credited && credited === canonTitleSlug(other.slug)
          && other.endYear != null && yearNow != null && other.endYear < yearNow) continue;
      // Containment: the other show's title sits INSIDE this show's title ("Mean Girls" inside
      // "School Girls; Or, The African Mean Girls Play"), so a URL for this show naturally
      // carries the other show's slug. Only call it a mismatch when the URL carries none of
      // this show's own distinctive tokens. School Girls opening night 2026-09-28 lost the
      // Guardian, Culture Sauce and Chicago Tribune reviews to this (BRO-4267).
      const contained = thisShow.slug.includes(other.slug) || idSlug.includes(otherIdSlug) || idSlugNorm.includes(otherIdSlugNorm);
      if (contained) {
        const otherTokens = new Set([...other.slug.split('-'), ...otherIdSlug.split('-')]);
        const vouching = [...thisTokens].filter(t => !otherTokens.has(t));
        // Whole path words only: "school" must not match "preschool".
        const hasWord = t => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(urlPath);
        const present = vouching.filter(hasWord);
        // One word is not enough: a real Mean Girls review whose slug happens to say
        // "high-school" must still be caught. Two of this show's own words (or all of
        // them when it has only one) have to appear before the URL is trusted...
        const needed = Math.min(2, vouching.length);
        if (needed > 0 && present.length >= needed) continue;
        // ...unless the URL reproduces this show's own phrase around the contained
        // title: the word that sits right next to the other show's title in THIS slug,
        // kept together the same way ("african-mean-girls" is School Girls' subtitle;
        // "mean-girls-high-school" and "mean-girls-school-edition" are not).
        if (present.length > 0) {
          const phrases = [];
          for (const [container, part] of [[thisShow.slug, other.slug], [idSlug, otherIdSlug], [idSlugNorm, otherIdSlugNorm]]) {
            const at = part ? container.indexOf(part) : -1;
            if (at < 0) continue;
            const before = container.slice(0, at).split('-').filter(Boolean).pop();
            const after = container.slice(at + part.length).split('-').filter(Boolean)[0];
            if (before && present.includes(before)) phrases.push(`${before}-${part}`);
            if (after && present.includes(after)) phrases.push(`${part}-${after}`);
          }
          if (phrases.some(p => urlPath.includes(p))) continue;
        }
      }
      if (hasSlugRun(urlPath, other.slug)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // BRO-4986: outlets often drop a leading "The" ("heart-of-rock-and-roll-
      // broadway-theater-review" for The Heart of Rock and Roll), so try the
      // other show's slug without it, as a whole hyphen-delimited run, under
      // the same exclusions and containment skips as the full slug.
      // A one-word remainder ("performers", "audience", "children") is an
      // ordinary word in review slugs, and a remainder made only of this
      // show's own words is the same play ("pirates-of-penzance" on Pirates!
      // The Penzance Musical), so neither counts.
      const bare = other.slug.startsWith('the-') ? other.slug.slice(4) : null;
      const bareWords = bare ? bare.split('-').filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t)) : [];
      if (bare && bare.length >= 8 && bare.includes('-') && !CROSS_SHOW_SLUG_EXCLUDE.has(bare)
          && !bareWords.every(t => thisTokens.has(t))
          && !URL_PATH_STOPWORDS.has(bare)
          && !thisShow.slug.includes(bare) && !idSlug.includes(bare) && !bare.includes(idSlug)
          && hasSlugRun(urlPath, bare)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // BRO-6569: outlets drop an inner connector too: The Telegraph's Exit the
      // King review is ".../exit-king-review-national-theatre-...", which sat on
      // The King and I. Same exclusions as the bare form above.
      const joined = stripConnectors(other.slug.replace(/^the-/, ''));
      const joinedWords = joined.split('-').filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t));
      // A word of this show's own title the other title lacks vouches for the
      // url: ".../bullets-broadway-...-guys-dolls/" is Bullets Over Broadway.
      const ownWordInUrl = () => [...thisTokens].some(t => !joinedWords.includes(t)
        && new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(urlPath));
      if (joined !== other.slug && joined !== bare && joined.length >= 8 && joined.includes('-')
          && !CROSS_SHOW_SLUG_EXCLUDE.has(joined) && !URL_PATH_STOPWORDS.has(joined)
          && !joinedWords.every(t => thisTokens.has(t))
          && !thisShow.slug.includes(joined) && !idSlug.includes(joined) && !idSlugNorm.includes(joined) && !joined.includes(idSlugNorm)
          && hasSlugRun(urlPath, joined) && !ownWordInUrl()) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // Also check a base-title slug (first significant words of the title, without
      // parentheticals or subtitles). Catches shows with long qualified slugs like
      // "monte-cristo-the-york-theatre-company-off-broadway" where a URL containing
      // just "monte-cristo" wouldn't match the full slug.
      const baseTitle = (other.title || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '')
        .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (baseTitle.length >= 6 && !URL_PATH_STOPWORDS.has(baseTitle)
          && baseTitle !== idSlug
          && !idSlug.startsWith(baseTitle) && !baseTitle.startsWith(idSlug)
          && hasSlugRun(urlPath, baseTitle)
          // A shortened title can be this show's own words ("Beautiful" in
          // "A Beautiful Noise"), even when the full titles are unrelated.
          && !baseTitle.split('-').every(t => thisShow.slug.split('-').includes(t))) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
    }
  } catch {}
  return null;
}

module.exports = {
  creditedTitleSlug,
  slugify,
  CROSS_SHOW_SLUG_EXCLUDE,
  buildShowSlugIndex,
  showRunYears,
  getShowSlugIndex,
  detectCrossShowUrlMismatch,
  shortTitleLeftExtension,
  sameTitleModuloCredit,
};
