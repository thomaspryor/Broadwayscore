'use strict';

const fs = require('fs');
const path = require('path');
const { titleToSlug, KNOWN_ALIASES } = require('../show-matching.js');
const { foldDiacritics } = require('../title-match.js');
const { slugify: urlSlugify } = require('../url-slug.js');
const { toDateMs } = require('../date-utils.js');
const { urlNamesOtherShow: canonicalUrlNamesOtherShow } = require('../url-names-other-show.js');

const name = 'slug-mismatch';
const description = 'Review URL slug does not mention show slug or any known alias (cross-show contamination)';

// Known Broadway/WE shows whose slugs we should flag when they appear in another show's URL.
// This is the "positive mismatch" case: if a review URL for schmigadoon-2026 contains
// "every-brilliant-thing", that's a red flag even beyond "doesn't mention schmigadoon."
// We derive the list dynamically from shows.json at run time via context.
const STOPWORDS = new Set([
  'review', 'broadway', 'show', 'musical', 'play', 'the', 'a', 'and', 'or',
  'west-end', 'london', 'nyc', 'opens', 'opening', 'stars', 'starring',
  'world', 'premiere', 'tryout', 'tickets',
]);

/**
 * Extract the last "meaningful" path segment(s) from a review URL and return
 * a lowercase slug-style string to search within.
 * e.g., "https://x.com/reviews/some-show-title-on-broadway-2026" → "some-show-title-on-broadway-2026"
 */
const UUID_RE_I = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function urlSearchSlug(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\.(html?|php|aspx?|cfm)$/i, '').replace(/\/$/, '');
    const segments = path.split('/').filter(Boolean);
    // Some outlets (e.g. Talkin' Broadway: /ParanormalActivity.html) use
    // camelCase path segments with no hyphen/space between words. Insert a
    // space at each lowercase/digit -> uppercase boundary, AND at an
    // uppercase-run -> titlecase boundary (Codex ship-check finding — an
    // all-caps show name glued to the next titlecase word, e.g. "SIX" +
    // "The" + "Musical" as "SIXTheMusical", has no lowercase/digit before
    // its first uppercase-to-uppercase transition, so the first rule alone
    // leaves it as one unbroken token) BEFORE lowercasing, so
    // urlMentionsAnySlug's word-boundary regex can find each title word as
    // a separate token instead of one unbroken run.
    const spaced = segments
      .map(s => s
        // A UUID is an id, never title words; drop it before the boundary
        // splits below cut it into word-like pieces (BRO-4697).
        .replace(UUID_RE_I, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        // Letter -> digit boundary too: Talkin' Broadway's "Proof26" /
        // "OurTown24" glue a production year onto the title (BRO-4697).
        .replace(/([A-Za-z])(\d)/g, '$1 $2'))
      .join(' ');
    return spaced.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Collect candidate slugs that, if present in the URL, indicate the review is
 * CORRECTLY about this show: the title-derived slug, shows.json slug, alias slugs,
 * and the show id without trailing year suffix.
 */
function buildAcceptSlugs(show, { titleWords = true } = {}) {
  // Fold accents first: titleToSlug drops non-ASCII, so "Amélie" would become
  // "amlie" and never match an "/amelie-review" URL (BRO-4697).
  const title = foldDiacritics(show.title || '');
  const titleSlug = titleToSlug(title);
  const slugs = new Set();
  if (show.slug) slugs.add(show.slug.toLowerCase());
  if (titleSlug) slugs.add(titleSlug);
  // A slash title ("Bernhardt/Hamlet", "If/Then") slugs to one glued word;
  // outlets write it with a hyphen ("/bernhardt-hamlet-review").
  if (title.includes('/')) slugs.add(titleToSlug(title.replace(/\s*\/\s*/g, ' ')));
  // Every punctuation run as a hyphen ("Label•less" -> "label-less"), the
  // site's own slug rule.
  slugs.add(urlSlugify(title));
  // Core title: subtitle and a "The Musical"/"The Play" tail removed, which is
  // how critics and URLs usually name the show ("SIX the Musical" -> "six",
  // "Dog Man - The Musical" -> "dog-man"). Whole-title match only.
  const core = title
    .replace(/(?:\s+[-–—]\s+|\s*:\s*).*$/, '')
    .replace(/\s+(?:the|a new)\s+(?:musical|play)$/i, '')
    .trim();
  if (core && core !== title) {
    const coreSlug = urlSlugify(core);
    if (coreSlug.length >= 3) slugs.add(coreSlug);
  }
  // Presenter prefix and bare "Musical" tail (BRO-5693): critics write
  // "Encores! The Wild Party" as "The Wild Party" and "The Spongebob Musical"
  // as "SpongeBob". Whole-name matches only, like the core title above.
  // Censored title ("Hatef*ck", BRO-5693): outlets spell the word out
  // ("/hatefuck/"). Keep the star; slugPattern() reads it as 1-3 letters.
  if (/[a-z]\*+[a-z]/i.test(title)) {
    slugs.add(title.toLowerCase().replace(/\*+/g, '*').replace(/[^a-z0-9*]+/g, '-').replace(/^-+|-+$/g, ''));
  }
  // The prefix is dropped only when two or more words remain.
  const variants = [title.replace(/^[^\s!]+!\s+(?=\S+\s+\S)/, '')];
  if (/\S\s+musical$/i.test(title)) variants.push(title.replace(/^the\s+/i, '').replace(/\s+musical$/i, ''));
  for (const variant of variants) {
    const v = variant.trim();
    if (v && v.toLowerCase() !== title.toLowerCase()) {
      const vSlug = urlSlugify(v);
      if (vSlug.length >= 4) slugs.add(vSlug);
    }
  }
  if (show.id) slugs.add(show.id.replace(/-\d{4}$/, '').toLowerCase());

  // Add aliases that map TO this show (reverse KNOWN_ALIASES lookup)
  const target = (show.slug || titleSlug || '').toLowerCase();
  for (const [alias, canonical] of Object.entries(KNOWN_ALIASES)) {
    if (canonical.toLowerCase() === target) {
      slugs.add(titleToSlug(alias));
    }
  }

  // Per-show URL-slug allowlist for revivals/renamed productions. Example:
  // shows.json can declare `urlAliases: ['the-giant', 'giant-musical']` so a
  // URL like `/giant-musical-review-broadway` is accepted even though the
  // derived slug is `giant`.
  if (Array.isArray(show.urlAliases)) {
    for (const alias of show.urlAliases) {
      if (typeof alias === 'string' && alias.trim()) {
        slugs.add(titleToSlug(alias));
        slugs.add(alias.toLowerCase());
      }
    }
  }

  // Add meaningful single-word tokens from the title (length>=4, not stopwords).
  // This catches "schmigadoon" in longer URLs even if our slug is "schmigadoon".
  // titleWords:false skips them for prose matching, where one common word of a
  // title ("great", "time") is no evidence the text is about the show.
  const significantWords = [];
  if (!titleWords) return Array.from(slugs).filter(Boolean);
  for (const token of title.toLowerCase().split(/[\s/]+/)) {
    const clean = token.replace(/[^a-z0-9]/g, '');
    if (clean.length >= 4 && !STOPWORDS.has(clean)) {
      slugs.add(clean);
      significantWords.push(clean);
    }
  }

  // Some outlets glue a multi-word title into one compound path segment with
  // NO separator at all — e.g. "Electra / Persona" -> "electrapersona-review"
  // (found live on electra-persona-west-end-2026, BRO-3025). A hyphen/space-
  // anchored slug can never match that via word boundaries even though the
  // review is unambiguously about this show. Add the fully-concatenated
  // significant words as their own accept-slug, still boundary-matched like
  // every other entry, so it can't swallow an unrelated substring.
  if (significantWords.length >= 2) slugs.add(significantWords.join(''));
  // The whole title glued INCLUDING its short words ("Building the Wall" ->
  // curtainup.com/buildingthewall17.html, BRO-7223): the join above drops "the".
  const squashed = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (squashed.length >= 8 && /[a-z]/.test(squashed)) slugs.add(squashed);

  return Array.from(slugs).filter(Boolean);
}

/**
 * Return true if any accept-slug appears as a whole token in the URL search slug.
 */
// Escape regex metacharacters so a slug (which may contain hyphens and unusual
// punctuation via future aliases) can be embedded literally. The previous
// version had `[\\]` which closed the char class early — `_` and friends were
// left unescaped, and `$`/`|`/`(` in an alias would blow up the RegExp ctor.
function escapeRegex(s) {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
}

// A slug as a regex source: literal, except a censor star stands for 1-3
// letters (buildAcceptSlugs keeps it only for censored titles).
function slugPattern(slug) {
  return escapeRegex(slug).replace(/\\\*/g, '[a-z]{1,3}');
}

function urlMentionsAnySlug(urlSlug, acceptSlugs) {
  for (const slug of acceptSlugs) {
    // Word-boundary match against slug tokens (hyphen/space-delimited)
    const re = new RegExp(`(^|[^a-z0-9])${slugPattern(slug)}($|[^a-z0-9])`, 'i');
    if (re.test(urlSlug)) return true;
  }
  return false;
}

// Path segments that are structure, not title words. A URL whose only word-like
// tokens come from this set carries no editorial slug at all.
const STRUCTURAL_PATH_WORDS = new Set([
  'content', 'article', 'articles', 'story', 'stories', 'news', 'item',
  'p', 'id', 'view', 'node', 'index', 'amp', 'www', 'html', 'htm', 'php',
  // londontheatrereviews.co.uk/post.cfm?p=<id>: an id-only query URL (BRO-5438)
  'post', 'cfm',
  // thetimes.co.uk/tto/arts/stage/theatre/article2924370.ece: section folders
  // plus a numeric id, no title words (BRO-7223)
  'tto', 'ece', 'arts', 'stage', 'theatre', 'theater',
  // talkinbroadway.com/page/ob/02_24_26b.html: date-only review pages, the
  // path never carries a title (BRO-6524)
  'page',
]);

/**
 * True when a review URL structurally CANNOT express a show slug, because its
 * path is an opaque identifier rather than an editorial slug.
 *
 * Some outlets never put the headline in the path. The Financial Times is the
 * standing example: every review lives at /content/<uuid>, e.g.
 * ft.com/content/ce137235-1a5a-4eef-b82a-d6f9e7f6a244. There is no slug to
 * match, so the mismatch check fired a hard error on a perfectly good FT review
 * of the right show and blocked the opening-night broadcast checklist gate
 * (found live on the-story-west-end-2026, 2026-09-05).
 *
 * This does NOT weaken the contamination signal the check exists for. That
 * signal is "this URL names a DIFFERENT show" — an opaque URL names no show
 * either way, so there was never anything to detect on these; the check was
 * only producing noise. A URL carrying ANY real word token is still checked in
 * full, so a slugged URL for the wrong show still errors.
 *
 * @param {string} urlSlug - output of urlSearchSlug()
 * @returns {boolean}
 */
// A UUID's hex groups can be all letters ("cafd"), which read as real words
// below; drop whole UUIDs first (ft.com/content/214ad92c-cafd-..., BRO-4697).
// urlSearchSlug already removes them; this covers callers passing raw text.
function isOpaqueUrlSlug(urlSlug) {
  if (!urlSlug) return true;
  // thestage.co.uk/reviews/<id> (BRO-5693): "review(s)" is path structure only
  // beside a 5+ digit id; "1776-review" / "reviews/1984" are title slugs.
  const words = urlSlug.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(t => /^\d{5,}$/.test(t))
      && words.every(t => /^\d+$/.test(t) || t === 'review' || t === 'reviews')) return true;
  const tokens = urlSlug.replace(UUID_RE_I, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 3) continue;          // 'p', 'id', short noise
    if (/\d/.test(t)) continue;          // hex/uuid chunks and numeric ids
    if (STRUCTURAL_PATH_WORDS.has(t)) continue;
    return false;                        // a real word — this URL has a slug
  }
  return true;
}

/**
 * True for an id-only CMS URL with no editorial words at all, e.g.
 * londontheatrereviews.co.uk/post.cfm?p=29349 (BRO-5438). Unlike a fully
 * opaque URL (FT /content/<uuid>) these keep the saved-text check: text that
 * exists and never names the show still flags; only a review with NO saved
 * text is skipped, since nothing can confirm or refute it.
 */
function isIdOnlyCmsUrl(urlSlug) {
  const tokens = (urlSlug || '').split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(t => t === 'post' || t === 'cfm' || /^\d+$/.test(t) || t === 'p');
}

/**
 * Regex for "this text names the show": the accept-slugs with hyphens relaxed
 * to any run of spaces/hyphens, matched on word boundaries. Shared with
 * fulltext-mentions-show.check.js so the two checks agree on what a mention is.
 */
function buildMentionRegex(show, opts) {
  // opts.minWords (BRO-4427): keep only multi-word slugs, so a one-word core
  // title or id stem ("cabaret" from "Cabaret at the Kit Kat Club") never counts.
  const minWords = (opts && opts.minWords) || 1;
  const patterns = buildAcceptSlugs(show, opts)
    .filter(s => s.split(/[^A-Za-z0-9]+/).filter(Boolean).length >= minWords)
    .map(s => slugPattern(s).replace(/\\-/g, '[^A-Za-z0-9]*'))
    .filter(s => s.length >= 3);
  if (patterns.length === 0) return null;
  return new RegExp(`(^|[^A-Za-z0-9])(${patterns.join('|')})($|[^A-Za-z0-9])`, 'i');
}

/**
 * url -> source text for the show's review-text files (fullText plus the
 * aggregator excerpts). Read lazily and only when a URL already failed the
 * slug test. A missing directory yields an empty map (nothing confirmed).
 */
// reviews.json and the review-text files disagree on scheme and "www." for the
// same article (Red / NY Daily News: http://www. vs https://www.), which made
// every text lookup miss (BRO-7121). Key both sides by scheme-less, www-less URL.
function urlKey(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

function loadSourceTextByUrl(reviewTextsRoot, showId, extraShowIds = []) {
  const byUrl = new Map();
  byUrl.fullTexts = new Map();
  byUrl.roundupUrls = new Map();
  if (!reviewTextsRoot) return byUrl;
  // extraShowIds: earlier runs whose reviews this show inherits (priorRuns,
  // BRO-4759). Their texts live in the earlier run's folder (BRO-5693).
  for (const id of [showId, ...extraShowIds]) readSourceTextDir(path.join(reviewTextsRoot, id), byUrl);
  return byUrl;
}

function readSourceTextDir(dir, byUrl) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!d || !d.url) continue;
    const segments = [d.fullText, d.bwwExcerpt, d.dtliExcerpt, d.showScoreExcerpt, d.pullQuote]
      .filter(t => typeof t === 'string' && t);
    byUrl.set(urlKey(d.url), (byUrl.get(urlKey(d.url)) || []).concat(segments));
    if (typeof d.bwwRoundupUrl === 'string' && d.bwwRoundupUrl
        && !d.wrongShow && !d.wrongProduction && !d.isRoundupArticle) {
      byUrl.roundupUrls.set(urlKey(d.url), (byUrl.roundupUrls.get(urlKey(d.url)) || []).concat(d.bwwRoundupUrl));
    }
    if (typeof d.fullText === 'string' && d.fullText
        && !d.isRoundupArticle && !d.wrongShow && !d.wrongProduction) {
      byUrl.fullTexts.set(urlKey(d.url), (byUrl.fullTexts.get(urlKey(d.url)) || []).concat(d.fullText));
    }
  }
  return byUrl;
}

/**
 * True when the review's own saved text names the show. A headline-style URL
 * ("/david-greenspan-shines") that never names the show is normal for many
 * outlets; cross-show contamination means the ARTICLE is about another show,
 * and then its text does not name this one either (BRO-4697: ~1,700 lifetime
 * hits were headline URLs on correctly filed reviews). The show must be named
 * in the lede (first LEDE_CHARS of a text or excerpt): a roundup or an article
 * about something else that names the show only in passing still flags.
 */
const LEDE_CHARS = 1500;
function sourceTextNamesShow(segments, mentionRe) {
  if (!mentionRe || !segments) return false;
  const list = Array.isArray(segments) ? segments : [segments];
  return list.some(t => typeof t === 'string' && mentionRe.test(t.slice(0, LEDE_CHARS)));
}

/**
 * True when a saved FULL text names the show at least REPEAT_MENTIONS times
 * anywhere in the body (BRO-6524). Regional and criticism pieces often open on
 * the plot or the company and name the play only later ("The Lifespan of a
 * Fact" appears after the lede), so the lede test above misses a correct
 * review. One mention anywhere is still not enough: a column or roundup names
 * a show once in passing (Musto columns, "also opening this month: X"), and
 * that must keep flagging. Only fullText counts: excerpts are short by design.
 */
const REPEAT_MENTIONS = 2;
function fullTextNamesShowRepeatedly(fullTexts, mentionRe) {
  if (!mentionRe || !fullTexts) return false;
  const global = new RegExp(mentionRe.source, 'gi');
  return fullTexts.some(t => typeof t === 'string' && (t.match(global) || []).length >= REPEAT_MENTIONS);
}

/**
 * True when the review was lifted from a BroadwayWorld review roundup written
 * about THIS show (BRO-7121). Roundup rows carry the critic's own link, often
 * a columnist index or a dead blog URL that cannot name the show (Red / NY
 * Daily News /columnists/dziemianowicz/index.html), and an excerpt that
 * names the play only by its characters. The roundup's own URL names the show
 * and is the provenance. A multi-show roundup ("Double Review Roundup 9 to 5
 * and Waiting for Godot", "... and More") names the show too yet vouches for
 * nothing, so it never confirms. Whole-title slugs only: one common title
 * word in a roundup URL is no evidence.
 */
const MULTI_SHOW_ROUNDUP_RE = /(^|-)(double|triple)-|roundup-and-more|broadway-blogs/i;
// A roundup is dated in its URL; a revival's or other market's roundup of the
// same title is years away from this production's opening (ship-check).
const ROUNDUP_DATE_WINDOW_DAYS = 75;
// A one-word title ("Red", "Company") sits inside other titles' roundup URLs
// ("Review-Roundup-THE-COMPANY-MEN"), so it must be followed by a date or one
// of the tails BWW puts after a show name, never by another title word.
const ROUNDUP_TITLE_TAIL = '(?:\\d{4,}|opens?|updating|live|on|in|at|is|review|roundup|starring|see|returns?|revival)';
function roundupNamesShow(roundupUrls, wholeTitleSlugs, openingDate) {
  if (!roundupUrls || roundupUrls.length === 0) return false;
  return roundupUrls.some(u => {
    const slug = urlSearchSlug(u);
    if (MULTI_SHOW_ROUNDUP_RE.test(slug)) return false;
    const dm = slug.match(/(?:^|-)(\d{4})(\d{2})(\d{2})$/);
    if (dm && openingDate) {
      const days = Math.abs(Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}`) - Date.parse(openingDate)) / 86400000;
      if (!(days <= ROUNDUP_DATE_WINDOW_DAYS)) return false;
    } else if (openingDate) {
      // Year-only slugs ("Review-Roundup-GREASE-2007") get a one-year window.
      const ym = slug.match(/-(\d{4})$/);
      if (ym && Math.abs(Number(ym[1]) - Number(String(openingDate).slice(0, 4))) > 1) return false;
    }
    return wholeTitleSlugs.some(t => {
      if (!/[-\s]/.test(t)) {
        return new RegExp(`(^|[^a-z0-9])roundup-${slugPattern(t)}(-${ROUNDUP_TITLE_TAIL}[^a-z]|-${ROUNDUP_TITLE_TAIL}$|$)`, 'i').test(slug)
          || new RegExp(`(^|\\s)(?:broadway-)?(?:blogs?-)?${slugPattern(t)}-review-roundup`, 'i').test(slug);
      }
      return urlMentionsAnySlug(slug, [t]);
    });
  });
}


/**
 * Show Score provenance (BRO-7121). A capsule post that covers several shows
 * ("theater-reviews-ambitious-sumo.html" also reviews Conversations with Mother)
 * has one URL and a slug for one show. Show Score files it under each show it
 * reviews, with a blurb per show. When THIS show's Show Score page lists the
 * URL with an excerpt that no other show's page repeats for that URL, the
 * aggregator vouches for the attribution (same idea as the BWW roundup rule).
 * An identical blurb under two shows is a copy, not a section, and a URL listed
 * under this show alone has no sibling section, so neither vouches.
 */
const SHOW_SCORE_DATE_WINDOW_DAYS = 120;
const showScoreCache = new Map();
function loadShowScoreDoc(file) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* missing */ }
  const cacheKey = `${file}@${mtime}`;
  if (showScoreCache.has(cacheKey)) return showScoreCache.get(cacheKey);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no file: nothing vouches */ }
  const byUrl = new Map();   // normalized url -> [{ showId, excerpt }]
  for (const [id, entry] of Object.entries((doc && doc.shows) || {})) {
    for (const r of (entry && entry.criticReviews) || []) {
      if (!r || !r.url) continue;
      const k = showScoreUrlKey(r.url);
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push({ showId: id, excerpt: String(r.excerpt || '').trim() });
    }
  }
  showScoreCache.set(cacheKey, byUrl);
  return byUrl;
}
function showScoreUrlKey(url) {
  // Only Blogger's mobile flag and fragments are noise; other query strings
  // (viewpage.aspx?record=7314) identify the page.
  return urlKey(url).replace(/#.*$/, '').replace(/[?&]m=[01]$/, '').replace(/\/$/, '').toLowerCase();
}
function showScoreVouches(showId, url, file, { openingDate, publishDate, hasSavedText } = {}) {
  if (!file) return false;
  // Saved text was already judged by the text tests above; Show Score never
  // overrides it (its classic error is show B's blurb under show A's URL).
  if (hasSavedText) return false;
  // Same production: a Show Score mislink to a revival years away vouches nothing.
  if (openingDate && publishDate) {
    const days = Math.abs(toDateMs(publishDate) - toDateMs(openingDate)) / 86400000;
    // NaN (an unparseable date) fails the comparison and refuses to vouch.
    if (!(days <= SHOW_SCORE_DATE_WINDOW_DAYS)) return false;
  }
  const rows = loadShowScoreDoc(file).get(showScoreUrlKey(url));
  if (!rows) return false;
  // Only an editorial post vouches: its last path segment is a hyphenated
  // headline slug (3+ words). Landing pages, category and id-only pages are
  // listed under unrelated shows and carry no per-show sections.
  const lastSeg = showScoreUrlKey(url).replace(/\?.*$/, '').split('/').filter(Boolean).pop() || '';
  if (lastSeg.replace(/\.(html?|php|aspx?)$/i, '').split('-').filter(Boolean).length < 3) return false;
  const mine = rows.find(r => r.showId === showId);
  if (!mine || !mine.excerpt) return false;
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Capsule signature: at least one OTHER show lists the same post with a
  // different blurb. A URL listed under this show alone (a Musto column filed
  // against a revival) is the contamination the check exists to catch.
  const others = rows.filter(r => r.showId !== showId);
  return others.length > 0 && !others.some(r => norm(r.excerpt) === norm(mine.excerpt));
}

/**
 * Regex for the show's venue name: the part before the first comma
 * ("Theater Wit, Chicago, IL" -> "Theater Wit"), a leading "The" optional and
 * Theatre/Theater interchangeable. null when the name is too short or is a
 * generic word on its own ("Theatre"), so it can never confirm anything.
 */
// Generic venue words, and market words that make "Broadway Theatre" or
// "West End Theatre" read as the phrase "a Broadway theater" (BRO-5693 review).
const GENERIC_VENUE_WORDS = new Set(['the', 'theatre', 'theater', 'center', 'centre', 'stage', 'hall', 'house', 'playhouse', 'company', 'studio', 'space',
  'broadway', 'off', 'west', 'end', 'london', 'new', 'york', 'city', 'music', 'opera', 'arts', 'performing', 'regional', 'chicago']);
function buildVenueRegex(show) {
  // "Signature Center/Romulus Linney Courtyard Theatre": either name counts.
  const names = foldDiacritics(String((show && show.venue) || '').split(',')[0]).split('/');
  const alts = [];
  for (const raw of names) {
    const words = raw.trim().replace(/^the\s+/i, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0 || words.join('').length < 5) continue;
    if (words.every(w => GENERIC_VENUE_WORDS.has(w))) continue;
    alts.push(words.map(w => (w === 'theatre' || w === 'theater') ? 'theat(?:re|er)' : escapeRegex(w)).join('[^A-Za-z0-9]+'));
  }
  if (alts.length === 0) return null;
  return new RegExp(`(^|[^A-Za-z0-9])(${alts.join('|')})($|[^A-Za-z0-9])`, 'i');
}

/**
 * True when a saved FULL text names the show's venue AND names the show beyond
 * a single passing mention (BRO-5693). Some outlets keep the title only in the
 * page header, which extraction drops, so the body uses the title's words
 * instead. Rules, so a different show at the same venue still flags:
 * - titles with fewer than two significant words never clear here (one word
 *   such as "Company" or "Rent" is ordinary prose);
 * - two or more whole-title mentions clear;
 * - otherwise, with the whole-title mentions removed, two or more DISTINCT
 *   significant title words must still appear ("Theater Wit, which staged
 *   London Road last fall" names the title once and does not clear).
 */
function significantTitleWords(show) {
  const title = foldDiacritics(String((show && show.title) || '')).toLowerCase();
  const out = new Set();
  for (const token of title.split(/[\s/]+/)) {
    const clean = token.replace(/[^a-z0-9*]/g, '');
    if (clean.replace(/\*/g, '').length >= 4 && !STOPWORDS.has(clean) && !/^\d+$/.test(clean)) out.add(clean);
  }
  return [...out];
}

function fullTextNamesVenueAndTitleWords(fullTexts, show, venueRe, mentionRe) {
  if (!venueRe || !fullTexts) return false;
  const words = significantTitleWords(show);
  if (words.length < 2) return false;
  const wordRes = words.map(w => new RegExp(`(^|[^A-Za-z0-9])${slugPattern(w)}(s|es)?(?=$|[^A-Za-z0-9])`, 'i'));
  const wholeRe = mentionRe ? new RegExp(mentionRe.source, 'gi') : null;
  return fullTexts.some((t) => {
    if (typeof t !== 'string' || !venueRe.test(t)) return false;
    if (wholeRe && (t.match(wholeRe) || []).length >= REPEAT_MENTIONS) return true;
    const rest = wholeRe ? t.replace(wholeRe, ' ') : t;
    return wordRes.filter(re => re.test(rest)).length >= 2;
  });
}

/**
 * Competing-show attribution (BRO-7204). The URL slug and the "names the show
 * by title" tests are proxies: a headline URL ("/it-takes-a-woman-2/") on a
 * review whose body says "Dolly Levi" but never the string "Hello, Dolly" fails
 * both, so every new outlet/URL shape produced a fresh "mismatch" and a fresh
 * card (BRO-4697, 5438, 5536, 5693, 6524, 7121). Absence of the title is not
 * evidence of contamination; contamination is text that is about ANOTHER show.
 * So the last test asks who the saved full text is about: it clears when one
 * distinctive word of this show's title recurs (OWN_MIN_MENTIONS+) and no other
 * show's whole title is named more often. Text about a different show names that
 * show, so it loses; a roundup/column naming rivals loses; generic title words
 * ("murder", "love") are not distinctive and never clear on their own.
 */
const OWN_MIN_MENTIONS = 2;
const DISTINCTIVE_MAX_TITLES = 3;
const RIVAL_SINGLE_WORD_MIN = 5;
const normWords = (s) => foldDiacritics(String(s || '')).toLowerCase()
  .replace(/['\u2018\u2019\u02bc`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

const titleIndexCache = new WeakMap();
function buildTitleIndex(shows) {
  if (titleIndexCache.has(shows)) return titleIndexCache.get(shows);
  const wordTitles = new Map();   // word -> Set(normalized title)
  const titles = new Set();       // normalized titles
  for (const s of shows) {
    const w = normWords(s.title);
    if (w.length === 0) continue;
    const key = w.join(' ');
    titles.add(key);
    for (const x of new Set(w)) {
      if (!wordTitles.has(x)) wordTitles.set(x, new Set());
      wordTitles.get(x).add(key);
    }
  }
  const lengths = [...new Set([...titles].map(t => t.split(' ').length))].filter(n => n >= 2);
  const idx = { wordTitles, titles, lengths };
  titleIndexCache.set(shows, idx);
  return idx;
}

function fullTextAboutThisShow(fullTexts, show, shows) {
  if (!fullTexts || !Array.isArray(shows) || shows.length === 0) return false;
  const { wordTitles, titles, lengths } = buildTitleIndex(shows);
  const ownKey = normWords(show.title).join(' ');
  const own = significantTitleWords(show).map(w => normWords(w).join(''))
    .filter(w => w && (wordTitles.get(w) || new Set()).size <= DISTINCTIVE_MAX_TITLES);
  if (own.length === 0) return false;
  return fullTexts.some((text) => {
    if (typeof text !== 'string' || !text) return false;
    const words = normWords(text);
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const ownScore = Math.max(...own.map(w => (counts.get(w) || 0) + (counts.get(w + 's') || 0) + (counts.get(w + 'es') || 0)));
    if (ownScore < OWN_MIN_MENTIONS) return false;
    let rivalScore = 0;
    const bump = (key) => {
      if (key === ownKey) return;
      const n = (rivalCounts.get(key) || 0) + 1;
      rivalCounts.set(key, n);
      if (n > rivalScore) rivalScore = n;
    };
    const rivalCounts = new Map();
    for (const w of words) if (w.length >= RIVAL_SINGLE_WORD_MIN && titles.has(w)) bump(w);
    for (const n of lengths) {
      for (let i = 0; i + n <= words.length; i++) {
        const key = words.slice(i, i + n).join(' ');
        if (titles.has(key)) bump(key);
      }
    }
    // Strictly more: a tie between this show and a rival is not attribution.
    return ownScore > rivalScore;
  });
}

/**
 * Contamination evidence in the URL itself (BRO-7204, second pass). A mismatch
 * only means the URL and saved text never name THIS show, which is true of
 * nearly every headline URL ("/a-can-of-worms/", "/PATRICK-MARMION-mute-cute")
 * on a correctly filed review. Cross-show contamination in this pipeline means
 * a review of ANOTHER show in shows.json got attached here, and its URL then
 * usually names that show ("/dolly-parton-on-broadway-9-to-5" filed under
 * Waiting for Godot, BRO-7121). Uses the contamination audit's own matcher
 * (scripts/lib/url-names-other-show.js: other title of 2+ words and 12+
 * chars as a whole run in the path, same-family titles skipped) so the two
 * detectors agree on what "names another show" means. Returns the other
 * show's title, or null.
 */
function urlNamesOtherShow(url, show, shows) {
  if (!url || !show || !Array.isArray(shows) || shows.length === 0) return null;
  const hit = canonicalUrlNamesOtherShow(url, show, shows);
  return hit ? hit.title : null;
}

// The lifetime sweep's isActionable rule (audit-slug-mismatch-lifetime.js).
function isContaminationEvidence(mismatch) {
  return !!(mismatch && mismatch.namesOtherShow);
}

function run(show, context) {
  const reviews = context.reviewsDoc[show.id] || [];
  if (reviews.length === 0) {
    return { ok: true, severity: 'ok', message: 'No reviews yet — skipping slug check' };
  }

  const acceptSlugs = buildAcceptSlugs(show);
  if (acceptSlugs.length === 0) {
    return { ok: true, severity: 'ok', message: 'Could not derive show slugs — skipping' };
  }

  const mismatches = [];
  const opaqueSkipped = [];
  let textConfirmed = 0;
  let sourceTextByUrl = null;
  // Whole title / alias only: a single title word in a lede proves nothing.
  const mentionRe = buildMentionRegex(show, { titleWords: false });
  // Repeat rule: multi-word names only, so "Chicago"/"Rent"/"Company" used
  // twice in prose never clears a URL (BRO-6524 review finding).
  const repeatRe = buildMentionRegex(show, { titleWords: false, minWords: 2 });
  const venueRe = buildVenueRegex(show);
  const wholeTitleSlugs = buildAcceptSlugs(show, { titleWords: false });
  // Prior-run folders this show inherits reviews from (BRO-4759 rows carry
  // inheritedFromShowId); the review's text was filed there (BRO-5693).
  const inheritedFrom = [...new Set(reviews.map(r => r.inheritedFromShowId).filter(Boolean))];
  for (const review of reviews) {
    if (!review.url) continue;
    const urlSlug = urlSearchSlug(review.url);
    if (urlMentionsAnySlug(urlSlug, acceptSlugs)) continue;
    // An opaque-id URL (FT /content/<uuid>) has no slug to mismatch — skip it
    // rather than reporting a hard error the operator can never resolve.
    if (isOpaqueUrlSlug(urlSlug)) {
      opaqueSkipped.push({ outletId: review.outletId, url: review.url });
      continue;
    }
    if (!sourceTextByUrl) sourceTextByUrl = loadSourceTextByUrl(context.reviewTextsRoot, show.id, inheritedFrom);
    const segs = sourceTextByUrl.get(urlKey(review.url));
    const fullTexts = sourceTextByUrl.fullTexts.get(urlKey(review.url));
    if (sourceTextNamesShow(segs, mentionRe)
        || fullTextNamesShowRepeatedly(fullTexts, repeatRe)
        || fullTextNamesVenueAndTitleWords(fullTexts, show, venueRe, mentionRe)
        || fullTextAboutThisShow(fullTexts, show, context.shows)
        || roundupNamesShow(sourceTextByUrl.roundupUrls.get(urlKey(review.url)), wholeTitleSlugs, show.openingDate)
        || showScoreVouches(show.id, review.url, context.showScorePath, {
          openingDate: show.openingDate, publishDate: review.publishDate, hasSavedText: !!(fullTexts && fullTexts.length),
        })) { textConfirmed++; continue; }
    if ((!segs || segs.length === 0) && isIdOnlyCmsUrl(urlSlug)) {
      opaqueSkipped.push({ outletId: review.outletId, url: review.url });
      continue;
    }
    mismatches.push({
      outletId: review.outletId,
      criticName: review.criticName,
      url: review.url,
      urlSlug,
      // Positive contamination evidence (or null: unattributed, no evidence
      // either way). The lifetime sweep's digest row warns only on new hits
      // that carry it (BRO-7204).
      namesOtherShow: urlNamesOtherShow(review.url, show, context.shows),
    });
  }

  if (mismatches.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: (opaqueSkipped.length
        ? `All ${reviews.length - opaqueSkipped.length} slugged review URL(s) mention show slug `
          + `(${opaqueSkipped.length} opaque-id URL(s) skipped: `
          + `${opaqueSkipped.map(o => o.outletId).join(', ')})`
        : `All ${reviews.length} review URL(s) mention show slug`)
        + (textConfirmed ? ` (${textConfirmed} without the slug confirmed by review text)` : ''),
    };
  }

  const message = mismatches.map(m =>
    `Review URL for ${m.outletId}/${m.criticName} does not mention show slug (checked: ${acceptSlugs.join(', ')}): ${m.url}`
  ).join('\n');

  return {
    ok: false,
    severity: 'error',
    message,
    details: {
      mismatches,
      acceptSlugs,
      showId: show.id,
      // Self-declared remediation (task #389 pattern, extended for BRO-219).
      // alert, not workflow: cross-show URL contamination needs a human to
      // confirm before excluding or reattributing the review.
      remediation: {
        kind: 'alert',
        key: `slug-mismatch:${show.id}`,
        conditionKey: `opening-night-slug-mismatch-${show.id}`,
        title: `Review URL cross-show mismatch on ${show.title || show.id}`,
        description: message,
        severity: 'error',
        reason: `${mismatches.length} review URL(s) never mention the show slug`,
      },
    },
  };
}

module.exports = {
  name, description, run, urlSearchSlug, buildAcceptSlugs, urlMentionsAnySlug,
  isOpaqueUrlSlug, isIdOnlyCmsUrl, buildMentionRegex, sourceTextNamesShow,
  fullTextNamesShowRepeatedly, buildVenueRegex, fullTextNamesVenueAndTitleWords,
  loadSourceTextByUrl, roundupNamesShow, urlKey, fullTextAboutThisShow,
  urlNamesOtherShow, isContaminationEvidence,
};
