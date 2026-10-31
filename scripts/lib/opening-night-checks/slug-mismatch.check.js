'use strict';

const fs = require('fs');
const path = require('path');
const { titleToSlug, KNOWN_ALIASES } = require('../show-matching.js');
const { foldDiacritics } = require('../title-match.js');
const { slugify: urlSlugify } = require('../url-slug.js');

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

function urlMentionsAnySlug(urlSlug, acceptSlugs) {
  for (const slug of acceptSlugs) {
    // Word-boundary match against slug tokens (hyphen/space-delimited)
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(slug)}($|[^a-z0-9])`, 'i');
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
    .map(s => escapeRegex(s).replace(/\\-/g, '[^A-Za-z0-9]*'))
    .filter(s => s.length >= 3);
  if (patterns.length === 0) return null;
  return new RegExp(`(^|[^A-Za-z0-9])(${patterns.join('|')})($|[^A-Za-z0-9])`, 'i');
}

/**
 * url -> source text for the show's review-text files (fullText plus the
 * aggregator excerpts). Read lazily and only when a URL already failed the
 * slug test. A missing directory yields an empty map (nothing confirmed).
 */
function loadSourceTextByUrl(reviewTextsRoot, showId) {
  const byUrl = new Map();
  if (!reviewTextsRoot) return byUrl;
  const dir = path.join(reviewTextsRoot, showId);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return byUrl; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!d || !d.url) continue;
    const segments = [d.fullText, d.bwwExcerpt, d.dtliExcerpt, d.showScoreExcerpt, d.pullQuote]
      .filter(t => typeof t === 'string' && t);
    byUrl.set(d.url, (byUrl.get(d.url) || []).concat(segments));
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
    if (!sourceTextByUrl) sourceTextByUrl = loadSourceTextByUrl(context.reviewTextsRoot, show.id);
    const segs = sourceTextByUrl.get(review.url);
    if (sourceTextNamesShow(segs, mentionRe)) { textConfirmed++; continue; }
    if ((!segs || segs.length === 0) && isIdOnlyCmsUrl(urlSlug)) {
      opaqueSkipped.push({ outletId: review.outletId, url: review.url });
      continue;
    }
    mismatches.push({
      outletId: review.outletId,
      criticName: review.criticName,
      url: review.url,
      urlSlug,
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
};
