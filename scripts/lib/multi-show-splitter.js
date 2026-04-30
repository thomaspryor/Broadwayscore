/**
 * multi-show-splitter.js — Split a multi-show critic roundup into per-show sections.
 *
 * Background (Notion 352637c5-416f-819c): Vulture/NYT/New Yorker publish
 * "week-in-theater" pieces where one critic reviews 2+ shows in a single article.
 * Each show gets a paragraph cluster. Existing infra (detectMultiShow +
 * trimMultiShowText) flags these as multi-show but only handles markdown / HTML /
 * ALL-CAPS section headings — Vulture/NYT use *photo captions* as boundaries
 * ("Actor names in <Title>, at <Venue>." followed by "Photo: ..."), which the
 * old trimmer doesn't see. Result: the trim fails and the LLM rejects the file
 * as wrong_show because the dominant show isn't the one the file is filed under.
 *
 * This splitter:
 *   1. Builds anchor list — every position where a known show's title appears
 *      in a production-credit context (caption pattern, "Title is at Venue"
 *      tail, or first occurrence of a clean title token).
 *   2. Sorts anchors by position; each section = [anchor[i], anchor[i+1]).
 *   3. Returns one entry per show with confidence and section text.
 *
 * Output is consumed by:
 *   - scripts/split-multi-show-roundups.js (offline backfill — splits existing
 *     isMultiShowReview files into per-show records).
 *   - The trim-multi-show fallback (when caption-style boundaries exist but
 *     no other heading does).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIG
// ============================================================================

// Min section length for a section to be emitted as its own review record.
// Below this, we drop the section (likely just a passing reference, not enough
// substance for ensemble scoring).
const MIN_SECTION_LENGTH = 500;

// Title tokens too short / too common to use as anchors without a caption-style
// production-credit hint. Same set used elsewhere in the codebase
// (multi-show-detector.ts SKIP_TITLES) — kept in sync.
const COMMON_WORD_SHOW_TITLES = new Set([
  'six', 'cats', 'rent', 'hair', 'fame', 'nine', 'once', 'annie', 'grease',
  'chicago', 'oliver', 'company', 'pippin',
  'well', 'good', 'home', 'high', 'spring', 'summer', 'november',
  'broadway', 'giant', 'molly',
  'baby', 'brothers', 'doubt', 'dream', 'race', 'rain', 'rose',
  'the audience', 'the performers', 'the news', 'the price', 'the visit',
  'the first', 'parade', 'just in time', 'english', 'holiday', 'care',
  'dorothy', 'working', 'emily', 'wanted', 'buddy', 'stanley', 'jackie',
  'fosse', 'sugar', 'irene', 'data', 'brooklyn', 'mail', 'marilyn',
  'legend', 'bent', 'contact', 'stomp', 'stages', 'raisin', 'betty',
  'lenny', 'sylvia', 'carrie',
]);

// ============================================================================
// SHOWS LOADING
// ============================================================================

let cachedShows = null;
let cachedShowsTimestamp = 0;
const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

/**
 * Load shows.json (cached for 60s).
 * Returns array of { id, title, category, status }.
 */
function loadShows() {
  const now = Date.now();
  if (cachedShows && (now - cachedShowsTimestamp) < 60_000) return cachedShows;
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    cachedShows = raw.shows || raw;
    cachedShowsTimestamp = now;
    return cachedShows;
  } catch {
    cachedShows = [];
    return cachedShows;
  }
}

// ============================================================================
// ANCHOR DETECTION
// ============================================================================

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build title variants for fuzzy matching.
 *
 * IMPORTANT: subtitle splits (colon, dash) only produce a variant when the
 * pre-separator portion has ≥2 words OR is ≥7 chars. Single short words
 * (e.g. "Jack" from "Jack: A Night on the Town with John Barrymore") are
 * too generic and false-match actor first names in photo captions.
 */
function getTitleVariants(title) {
  const lower = (title || '').toLowerCase().trim();
  if (!lower) return [];
  const variants = new Set([lower]);

  const trySplit = (sep) => {
    if (!lower.includes(sep)) return;
    const head = lower.split(sep)[0].trim();
    if (!head) return;
    const wordCount = head.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 2 || head.length >= 7) variants.add(head);
  };
  trySplit(':');
  trySplit(' - ');

  if (lower.includes(' & ')) variants.add(lower.replace(/ & /g, ' and '));
  if (lower.includes(' and ')) variants.add(lower.replace(/ and /g, ' & '));
  // Handle articles ("The Outsiders" ↔ "Outsiders") only when remainder is
  // distinctive (≥6 chars).
  if (/^the\s+/i.test(lower)) {
    const rest = lower.replace(/^the\s+/i, '');
    if (rest.length >= 6) variants.add(rest);
  }

  return [...variants].filter(v => v && v.length >= 4);
}

// Regex for photo-credit markers. Multi-show roundups always use one of these
// to attribute photographs, and the photo caption itself names the show.
// "Photo:" / "Photograph:" — Vulture, New Yorker, generic outlets
// "Credit..." / "Credit:" — NYT, Variety, some Hollywood Reporter
const PHOTO_CREDIT_RE = /\b(?:Photo(?:graph)?\s*:|Credit\s*(?:\.\.\.|:))/gi;

/**
 * Find caption-style anchors by scanning for photo-credit markers and looking
 * back ~300 chars to identify which show is named in the caption.
 *
 * Returns array of { position, kind: 'caption', showId, showTitle, raw }
 * sorted by position. Each entry maps a photo-credit marker to a single show.
 *
 * Captions where two or more shows are named (or none) are skipped — they're
 * ambiguous and we don't want to false-attribute a section.
 */
function findCaptionAnchors(text, shows) {
  if (!text || !shows || !shows.length) return [];

  const credits = [];
  PHOTO_CREDIT_RE.lastIndex = 0;
  let m;
  while ((m = PHOTO_CREDIT_RE.exec(text)) !== null) {
    credits.push({ position: m.index, marker: m[0] });
  }

  if (!credits.length) return [];

  // Pre-build per-show production-credit regex list. Two shapes are accepted:
  //
  //   Pattern A (venue-anchored, quotes optional):
  //     \b(?:in|with(?:\s+the\s+cast\s+of)?|of)\s+["“”']?<Title>["“”']?(?:,\s+at|\s+at)\s+(?:the\s+)?[A-Z]
  //   — Vulture: "...in Kenrex, at the Lucille Lortel"
  //   — NYT:     "...with the cast of "Anonymous" at Spit&Vigor's theater"
  //
  //   Pattern B (descriptor-anchored, REQUIRES quotes around title):
  //     \b(?:in|of|with)\s+["“”']<Title>["“”',]?,\s*[A-Z][a-z]
  //   — NYT:     "...in "The Reservoir," Jake Brasch's intergenerational comedy"
  //
  // Without one of these anchors, a bare title in prose ("rope tricks",
  // "girls' outfits", "the heart of the story") would falsely match. Both
  // patterns require a photo-credit marker within ≤500 chars after — the
  // outer scanner already enforces that by walking from the credit position
  // backward into the caption window.
  const showVariants = [];
  for (const show of shows) {
    if (!show || !show.id || !show.title) continue;
    if (show.title.length < 3) continue;
    const tLow = show.title.toLowerCase();
    if (COMMON_WORD_SHOW_TITLES.has(tLow)) continue;
    const variants = getTitleVariants(show.title);
    if (!variants.length) continue;
    const escaped = variants.map(escapeRegex);
    const titleAlt = escaped.join('|');
    // Pattern A: venue-anchored.
    const reVenue = new RegExp(
      `\\b(?:in|with(?:\\s+the\\s+cast\\s+of)?|of)\\s+["“”']?(?:${titleAlt})["“”']?(?:,\\s+at|\\s+at)\\s+(?:the\\s+)?[A-Z]`,
      'i'
    );
    // Pattern B: descriptor-anchored, title MUST be in quotes.
    // Trailing pattern allows the comma/quote in either order:
    //   "Reservoir," Jake     (comma inside closing quote — NYT style)
    //   "Reservoir", Jake     (comma outside closing quote)
    const reDescriptor = new RegExp(
      `\\b(?:in|of|with)\\s+["“”'](?:${titleAlt})[",”’'\\s]*[,]\\s*[",”’'\\s]*[A-Z]`,
      'i'
    );
    showVariants.push({ show, reVenue, reDescriptor });
  }

  const anchors = [];
  for (const credit of credits) {
    // The caption itself is bounded by the previous paragraph break and the
    // photo-credit marker. Walking back to the paragraph break (rather than a
    // fixed-size window) keeps prior-paragraph cross-references out of the
    // match window — e.g. NYT roundups discuss all 4 shows in one paragraph
    // before the first photo, and a 300-char window would swallow that.
    const captionStart = findCaptionStart(text, credit.position);
    const caption = text.slice(captionStart, credit.position);

    // Caption blocks are short (≤400 chars typical). If the caption is much
    // longer, it's not a real photo caption — skip rather than risk
    // false-attribution.
    if (caption.length > 600) continue;
    if (caption.length < 20) continue;

    // Find all shows named in this caption window via production-credit
    // anchors.
    const matches = [];
    for (const sv of showVariants) {
      if (sv.reVenue.test(caption) || sv.reDescriptor.test(caption)) {
        matches.push(sv.show);
      }
    }

    // Only accept captions with EXACTLY one show — multi-show captions are
    // ambiguous (which show does the next section belong to?) and zero-show
    // captions are just generic photo credits with no production attribution.
    if (matches.length === 1) {
      anchors.push({
        position: captionStart,
        kind: 'caption',
        creditPosition: credit.position,
        showId: matches[0].id,
        showTitle: matches[0].title,
        raw: caption.slice(-120),
      });
    }
  }

  anchors.sort((a, b) => a.position - b.position);
  return anchors;
}

/**
 * Find the start of a caption — walk back from the photo-credit marker to the
 * preceding PARAGRAPH break (\n\n). The caption itself often ends with a
 * single \n before the "Photo:" tag (e.g. Vulture: "...Lucille Lortel.\n Photo: ...")
 * so we DON'T stop at single newlines — that would slice off the caption text
 * and leave a 1-char window. Falls back to text-start if no paragraph break
 * within reach.
 */
function findCaptionStart(text, creditPos) {
  if (creditPos <= 0) return 0;
  const lookBack = Math.max(0, creditPos - 500);
  const slice = text.slice(lookBack, creditPos);
  // Paragraph break (\n\n) — authoritative caption boundary.
  const dbl = slice.lastIndexOf('\n\n');
  if (dbl !== -1) return lookBack + dbl + 2;
  // No paragraph break within 500 chars — text starts here (article opens
  // with a caption, like Vulture roundups do).
  return lookBack;
}

/**
 * Find tailrun anchors: closing-line patterns like "<Title> is at <Venue>
 * through <date>". Distinct from caption anchors because they don't have a
 * photo-credit nearby — they appear at the bottom of the article in a
 * dense run-information block.
 */
function findTailrunAnchors(text, shows) {
  if (!text) return [];
  const anchors = [];
  for (const show of shows) {
    if (!show || !show.id || !show.title) continue;
    if (show.title.length < 3) continue;
    const tLow = show.title.toLowerCase();
    if (COMMON_WORD_SHOW_TITLES.has(tLow)) continue;
    const variants = getTitleVariants(show.title);
    for (const variant of variants) {
      const escaped = escapeRegex(variant);
      const tailRe = new RegExp(
        `(?<![A-Za-z])${escaped}\\s+(?:is\\s+at|plays\\s+at|runs\\s+at|continues\\s+at|opens\\s+at|opened\\s+at|now\\s+playing\\s+at)\\s+(?:the\\s+)?[A-Z]`,
        'gi'
      );
      let m;
      while ((m = tailRe.exec(text)) !== null) {
        const lookahead = text.slice(m.index, Math.min(text.length, m.index + 200));
        const inFinalBlock = m.index >= text.length - 600;
        const hasDateMarker = /\b(?:through|until|closes|ends?\s+(?:on|its\s+run)|in\s+previews\s+through|until\s+further\s+notice|extended)\b/i.test(lookahead);
        if (hasDateMarker || inFinalBlock) {
          anchors.push({
            position: m.index,
            kind: 'tailrun',
            showId: show.id,
            showTitle: show.title,
            raw: m[0],
          });
        }
      }
    }
  }
  anchors.sort((a, b) => a.position - b.position);
  return anchors;
}

/**
 * Legacy compatibility: returns title-specific anchors (caption + tailrun + plain).
 * Used by the test surface and any external callers that still want per-title
 * anchor inspection. Internally splitMultiShowArticle now uses findCaptionAnchors
 * + findTailrunAnchors directly, which is more robust on varied caption shapes.
 */
function findAnchorsForTitle(text, title, shows) {
  if (!text || !title) return [];
  // Build a single-element shows list so the photo-credit scanner restricts
  // matches to this title.
  const showsList = shows || [{ id: 'lookup', title }];
  const captionAnchors = findCaptionAnchors(text, showsList).filter(a => a.showTitle === title || a.showId === showsList[0].id);
  const tailrunAnchors = findTailrunAnchors(text, [{ id: showsList[0].id, title }]);
  const variants = getTitleVariants(title);
  const plain = [];
  for (const variant of variants) {
    if (COMMON_WORD_SHOW_TITLES.has(variant)) continue;
    const escaped = escapeRegex(variant);
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      plain.push({ position: m.index, kind: 'plain', raw: m[0], variant });
    }
  }
  return [...captionAnchors, ...tailrunAnchors, ...plain].sort((a, b) => a.position - b.position);
}

// ============================================================================
// SPLITTER
// ============================================================================

/**
 * Split a multi-show article into per-show sections.
 *
 * Strategy:
 *   1. For each show in shows.json, find its primary anchor in text.
 *   2. Drop shows with no anchor or only weak (plain) anchors when ≥2 strong
 *      (caption/tailrun) anchors exist.
 *   3. Sort matched shows by primary-anchor position.
 *   4. Each section = [show[i].position, show[i+1].position) trimmed back to
 *      the previous paragraph boundary so we don't slice mid-sentence.
 *
 * @param {string} text
 * @param {Array<{id, title, category?}>} [showsList] - Defaults to shows.json
 * @param {object} [options]
 * @param {string[]} [options.allowedCategories] - Only consider shows of these
 *     categories (e.g. ['broadway','off-broadway']). Default: all.
 * @param {number} [options.minSectionLength=MIN_SECTION_LENGTH]
 * @returns {Array<{ showId, showTitle, anchorPosition, sectionStart, sectionEnd, sectionText, anchorKind }>}
 */
function splitMultiShowArticle(text, showsList, options = {}) {
  if (!text || text.length < 800) return [];
  const allShows = showsList || loadShows();
  const allowedCategories = options.allowedCategories || null;
  const minSectionLength = options.minSectionLength || MIN_SECTION_LENGTH;

  // Filter shows by category if requested. Don't filter by status — closed-show
  // titles still appear as comparisons in roundups, and we want to skip those
  // sections regardless of whether the closed show still gets a record.
  const shows = allowedCategories
    ? allShows.filter(s => s && allowedCategories.includes(s.category))
    : allShows;

  // 1. Find caption anchors (photo-credit-anchored) and tailrun anchors.
  const captionAnchors = findCaptionAnchors(text, shows);
  const tailrunAnchors = findTailrunAnchors(text, shows);

  // 2. Per-show: pick earliest strong anchor (caption preferred over tailrun).
  const showToAnchor = new Map();
  for (const a of captionAnchors) {
    const cur = showToAnchor.get(a.showId);
    if (!cur || a.position < cur.position) showToAnchor.set(a.showId, a);
  }
  for (const a of tailrunAnchors) {
    if (showToAnchor.has(a.showId)) continue; // caption already wins
    const cur = showToAnchor.get(a.showId);
    if (!cur || a.position < cur.position) showToAnchor.set(a.showId, a);
  }

  if (showToAnchor.size < 2) return [];

  // 3. Build candidate list, sorted by position.
  const filtered = [...showToAnchor.values()].map(a => ({
    showId: a.showId,
    showTitle: a.showTitle,
    primary: a,
  })).sort((a, b) => a.primary.position - b.primary.position);

  // 3. Build sections. Each section spans from this anchor's section-start to
  //    the next anchor's section-start. Section-start = trimmed back to nearest
  //    paragraph boundary (double newline) at-or-before the anchor position,
  //    so the photo caption/byline that precedes the anchor stays with that
  //    section's body.
  const sections = [];
  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const next = filtered[i + 1];

    // Find the paragraph boundary at-or-before this anchor.
    // Look back for double-newline (\n\n) or large whitespace gap; fall back to
    // the previous newline if none found.
    const sectionStart = findParagraphStart(text, cur.primary.position);
    const sectionEnd = next
      ? findParagraphStart(text, next.primary.position)
      : text.length;

    const sectionText = text.slice(sectionStart, sectionEnd).trim();
    if (sectionText.length < minSectionLength) continue;

    sections.push({
      showId: cur.showId,
      showTitle: cur.showTitle,
      anchorPosition: cur.primary.position,
      anchorKind: cur.primary.kind,
      sectionStart,
      sectionEnd,
      sectionText,
    });
  }

  return sections;
}

/**
 * Walk back from `position` to the start of the paragraph it's in.
 * A paragraph break is double-newline; falls back to last single newline if
 * none found within reach.
 */
function findParagraphStart(text, position) {
  if (position <= 0) return 0;
  // Look for double-newline within 4000 chars before.
  const lookBack = Math.max(0, position - 4000);
  const slice = text.slice(lookBack, position);
  const dblIdx = slice.lastIndexOf('\n\n');
  if (dblIdx !== -1) return lookBack + dblIdx + 2;
  // Fall back to last single newline.
  const sglIdx = slice.lastIndexOf('\n');
  if (sglIdx !== -1) return lookBack + sglIdx + 1;
  return 0;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  splitMultiShowArticle,
  findCaptionAnchors,
  findTailrunAnchors,
  findAnchorsForTitle,
  getTitleVariants,
  loadShows,
  // Test surface
  _internal: {
    findParagraphStart,
    findCaptionStart,
    COMMON_WORD_SHOW_TITLES,
  },
};
