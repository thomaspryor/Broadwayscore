'use strict';

/**
 * multi-show-review-fanout.js — file one critic article that reviews several
 * shows under EVERY show it reviews (BRO-4431).
 *
 * The problem: a review-texts file is discovered for one show (an aggregator
 * cites it, a SERP hit, a reader submission) and collected under that show
 * only. When the article is a multi-show piece the other shows never get it:
 *   - Vulture, Sara Holdren, "Reviews: How Shakespeare Saved My Life / Arias
 *     With a Twist" (photo-caption sections) sat under one show only.
 *   - New Yorker, Emily Nussbaum, "Gut Renos of Ionesco and Chekhov" (Delirium
 *     + The Cherry Orchard at the Armory): no caption, no heading; each half
 *     opens by introducing its show in quotes.
 *   - Theatrely, Joey Sims, "Review Roundup: Pre-Existing Condition, The Body
 *     of Mary" ("—————" separator between the capsules).
 * multi-show-splitter.js already handled the caption shape, but only in the
 * offline split-multi-show-roundups.js backfill, which no workflow ran.
 *
 * This module plans the split (pure) and applies it to a file on disk. It is
 * called by every path that writes review text (collect-review-texts.js,
 * ingest-review-from-url.js,
 * ingest-urls.js) and by the split-multi-show-roundups.js backfill.
 *
 * Three strategies, first hit wins:
 *   1. caption  — multi-show-splitter.splitMultiShowArticle (unchanged).
 *   2. intro    — find where each in-window show is INTRODUCED (quoted title,
 *                 or the title right after a separator rule / at the start),
 *                 cut at the start of that sentence, then require every
 *                 section to be about its own show: it names its show more
 *                 often than any other planned show, is >= MIN_SECTION_CHARS
 *                 and >= MIN_SECTION_SHARE of the article.
 *   3. joint    — one running piece on two or three shows whose lede or
 *                 closing listing names them all (jointSections, BRO-5895).
 *                 Opt-in for now, see jointEnabled.
 * Candidate shows are limited to productions opening within the publish-date
 * window, in the same market as the file's own show (NYC vs London), so a
 * passing comparison to a decades-old production ("the much praised 'Our
 * Class'") never becomes a section. The file's own show must be one of the
 * sections: an article whose sections are all other shows is a misfiling,
 * handled by the wrong-show path, not here.
 */

const fs = require('fs');
const path = require('path');
const { splitMultiShowArticle, loadShows, COMMON_WORD_SHOW_TITLES } = require('./multi-show-splitter');
const { normalizeTitle } = require('./title-match');

const MIN_TEXT_CHARS = 800;
const MIN_SECTION_CHARS = 600;
const MIN_SECTION_SHARE = 0.15;
// Publish-date window for candidate productions (days).
const WINDOW_BEFORE_DAYS = 150;
const WINDOW_AFTER_DAYS = 45;
const DAY_MS = 86400000;
// The first show's introduction must fall within this share of the article.
const FIRST_INTRO_MAX_SHARE = 0.4;
// A later section's show must be named within this many chars of its start.
const INTRO_LEAD_CHARS = 160;
// Partial texts can't be sectioned reliably (the missing tail may be the
// rest of the first show); invalid ones only when rejected for wrong/multi show.
const PARTIAL_TIERS = new Set(['truncated', 'excerpt', 'stub']);

const SEPARATOR_RE = /(?:[—–-]\s*){4,}|(?:\*\s*){3,}|(?:•\s*){3,}|(?:◆\s*){1,3}(?=\s)/g;

function marketOf(category) {
  const c = String(category || '').toLowerCase();
  if (c === 'broadway' || c === 'off-broadway') return 'nyc';
  if (c === 'west-end' || c === 'off-west-end') return 'london';
  return c || null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Title variants worth matching in prose: the full title and, for
 * "Main: Subtitle" / "Main (Of God)" titles, the main part when it is still
 * specific (>= 2 words). Returned as raw-text regex sources.
 */
function titleVariants(title) {
  const out = new Set();
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  out.add(t);
  const main = t.split(/\s*[:(]\s*/)[0].trim();
  if (main && main !== t && main.split(/\s+/).length >= 2) out.add(main);
  return [...out];
}

function titleRegexSource(variant) {
  // Words may be joined by any punctuation/space run in prose ("Brooklyn’s
  // Bridge", "Pre-Existing Condition"); a leading "The" is optional.
  const words = variant
    .replace(/^the\s+/i, '')
    .split(/[\s\-–—:,.;!?()]+/)
    .filter(Boolean)
    .map((w) => escapeRe(w).replace(/['’]/g, "['’]"));
  if (!words.length) return null;
  return `(?:the\\s+)?${words.join("[\\s\\-–—:,.;'’]*")}`;
}

/**
 * Build a matcher for one show. Single-word titles are only accepted when
 * capitalised as written, and only count as an INTRODUCTION when quoted; a
 * common-word title ("Six", "Company") is never matched bare at all.
 */
function buildShowMatcher(show) {
  const variants = titleVariants(show.title);
  const norm = normalizeTitle(show.title);
  const singleWord = norm.split(' ').length === 1;
  if (COMMON_WORD_SHOW_TITLES.has(norm) || COMMON_WORD_SHOW_TITLES.has(String(show.title || '').toLowerCase())) {
    return null;
  }
  if (singleWord && norm.length < 5) return null;
  const sources = variants.map(titleRegexSource).filter(Boolean);
  if (!sources.length) return null;
  const body = `(?:${sources.join('|')})`;
  const flags = singleWord ? 'g' : 'gi';
  return {
    show,
    singleWord,
    any: new RegExp(`(?<![\\w’'])${body}(?![\\w])`, flags),
    // Opening quote not glued to a word (so "Julio’s" is not an opener), and
    // the closing quote not followed by a letter ("Sting’s" is a possessive,
    // not a quoted title). A quoted title inside parentheses right after a
    // name is a credit ("Joe Mantello (“Other Desert Cities”)"), handled by
    // the caller.
    quoted: new RegExp(`(?<![\\w’'])[“"‘'*_]\\s*${body}\\s*[,.!?]?\\s*[”"’'*_](?![A-Za-z])`, flags),
  };
}

function countMatches(re, text) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

function firstIndex(re, text, skip) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!skip || !skip(m.index)) return m.index;
  }
  return -1;
}

/** "(“Title”)" or "(Title)": a credit reference, not an introduction. */
function isParenthetical(text, at) {
  return /\(\s*$/.test(text.slice(Math.max(0, at - 3), at));
}

/** Start of the sentence containing `pos` (or the separator just before it). */
// A theatre listing line: street address, phone number, or price range.
const LISTING_LINE_RE = /\b\d+\s+[NSEW]\.?\s+\d+(?:st|nd|rd|th)\s+St\b|\b\d{3}-\d{3}-\d{4}\b|\$\d+(?:\.\d\d)?\s*-\s*\$\d+/;
const LISTING_MAX_LINE = 80;
const LISTING_LEDE_MAX = 400;

/**
 * Start of a listing block (2+ short listing paragraphs, optionally followed
 * by one short lede paragraph) that ends right at `cut`, or null. Never
 * reaches back past `floor`.
 */
function listingLedStart(text, cut, floor) {
  const paras = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  const window = text.slice(floor, cut);
  let m;
  while ((m = re.exec(window))) paras.push({ at: floor + m.index, body: m[0].trim() });
  if (!paras.length) return null;
  let i = paras.length - 1;
  const isListing = (p) => p.body.length <= LISTING_MAX_LINE;
  if (!isListing(paras[i]) || !LISTING_LINE_RE.test(paras[i].body)) {
    if (paras[i].body.length > LISTING_LEDE_MAX) return null;
    i--; // one lede paragraph between the listing and the cut
  }
  let start = null;
  let listingHits = 0;
  while (i >= 0 && isListing(paras[i])) {
    if (LISTING_LINE_RE.test(paras[i].body)) listingHits++;
    start = paras[i].at;
    i--;
  }
  return listingHits >= 2 ? start : null;
}

function sentenceStart(text, pos) {
  let i = pos;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === '\n') break;
    const prev = text[i - 2] || '';
    const endsSentence = ch === '.' || ch === '!' || ch === '?'
      || ((ch === '”' || ch === '"') && (prev === '.' || prev === '!' || prev === '?'));
    if (endsSentence && /\s/.test(text[i] || ' ')) {
      // "Mr. X" style abbreviations are rare enough in review leads to ignore.
      break;
    }
    i--;
  }
  while (i < pos && /\s/.test(text[i])) i++;
  return i;
}

function stripSeparators(s) {
  return s.replace(SEPARATOR_RE, ' ').replace(/[ \t]+\n/g, '\n').replace(/\s{3,}/g, '\n\n').trim();
}

/**
 * Productions a review published on `publishDate` could be about, in the same
 * market as the file's own show.
 */
function candidateShows(shows, ownShow, publishDate) {
  const pub = require('./date-utils').toDateMs(publishDate) || Date.now();
  const market = ownShow ? marketOf(ownShow.category) : null;
  return shows.filter((s) => {
    if (!s || !s.id || !s.title) return false;
    if (ownShow && s.id === ownShow.id) return true;
    if (market && marketOf(s.category) !== market) return false;
    const od = Date.parse(s.openingDate || s.previewsStartDate || '');
    if (!od) return false;
    return od >= pub - WINDOW_BEFORE_DAYS * DAY_MS && od <= pub + WINDOW_AFTER_DAYS * DAY_MS;
  });
}

/**
 * Pick one production per normalized title (The Cherry Orchard has three
 * 2026 productions): the file's own show wins, else the one whose opening is
 * closest to the publish date.
 */
function dedupeProductions(cands, ownShowId, publishDate) {
  const pub = require('./date-utils').toDateMs(publishDate) || Date.now();
  const byTitle = new Map();
  for (const s of cands) {
    const key = normalizeTitle(s.title);
    const cur = byTitle.get(key);
    if (!cur) { byTitle.set(key, s); continue; }
    if (cur.id === ownShowId) continue;
    if (s.id === ownShowId) { byTitle.set(key, s); continue; }
    const d = (x) => Math.abs((Date.parse(x.openingDate || x.previewsStartDate || '') || 0) - pub);
    if (d(s) < d(cur)) byTitle.set(key, s);
  }
  return [...byTitle.values()];
}

/**
 * Strategy 2: introduction-point segmentation. Returns sections in the same
 * shape splitMultiShowArticle uses ({ showId, showTitle, sectionText,
 * anchorKind }) or [] when the article is not confidently multi-show.
 */
function introSections(text, shows, ownShowId, publishDate) {
  const ownShow = shows.find((s) => s.id === ownShowId) || null;
  if (!ownShow) return [];
  // Needs a real publish date, and the file's own production must be in the
  // window too: an old article misfiled under a revival (wrong production)
  // would otherwise "introduce" whatever else is running now.
  const pub = require('./date-utils').toDateMs(publishDate);
  if (!pub) return [];
  const ownOpen = Date.parse(ownShow.openingDate || ownShow.previewsStartDate || '');
  if (!ownOpen || ownOpen < pub - WINDOW_BEFORE_DAYS * DAY_MS || ownOpen > pub + WINDOW_AFTER_DAYS * DAY_MS) return [];
  const cands = dedupeProductions(candidateShows(shows, ownShow, publishDate), ownShowId, publishDate);
  const matchers = cands.map(buildShowMatcher).filter(Boolean);

  // Separator positions: a title right after a separator rule is an intro.
  const sepEnds = [];
  SEPARATOR_RE.lastIndex = 0;
  let sm;
  while ((sm = SEPARATOR_RE.exec(text))) sepEnds.push(sm.index + sm[0].length);

  // ALL-CAPS headings ("ARIAS WITH A TWIST ... THE CHERRY ORCHARD" in a
  // Theatrely capsule round-up whose extracted text lost its paragraphs).
  const headings = [];
  const HEADING_RE = /(?<![A-Za-z’'])[A-Z][A-Z0-9’'&:,.!\- ]{4,}[A-Z0-9](?![A-Za-z])/g;
  let hm;
  while ((hm = HEADING_RE.exec(text))) {
    const h = hm[0].trim();
    if (h.split(/\s+/).length < 2 && h.length < 8) continue;
    headings.push({ at: hm.index, norm: normalizeTitle(h), showId: null });
  }

  const intros = [];
  for (const m of matchers) {
    // An exact ALL-CAPS title heading is the strongest introduction there is.
    const norms = new Set(titleVariants(m.show.title).map((v) => normalizeTitle(v)));
    const head = headings.find((h) => !h.showId && norms.has(h.norm));
    if (head) {
      head.showId = m.show.id;
      intros.push({ m, at: head.at, afterSeparator: true, heading: true });
      continue;
    }
    const quotedAt = firstIndex(m.quoted, text, (at) => isParenthetical(text, at));
    const anyAt = firstIndex(m.any, text, (at) => isParenthetical(text, at));
    let at = -1;
    if (quotedAt >= 0) at = quotedAt;
    if (!m.singleWord && anyAt >= 0) {
      // A bare multi-word title counts as an introduction at the very start
      // of the article or within the lead of a separated capsule.
      const leadOk = anyAt < 250 || sepEnds.some((e) => anyAt >= e && anyAt - e < 250);
      if (leadOk && (at < 0 || anyAt < at)) at = anyAt;
    }
    if (at < 0) continue;
    intros.push({ m, at, afterSeparator: sepEnds.some((e) => at >= e && at - e < 250) });
  }
  if (intros.length < 2) return [];
  intros.sort((a, b) => a.at - b.at);
  // The first show must be introduced near the top; a title first quoted
  // mid-article is a comparison inside a single review.
  if (intros[0].at > Math.max(400, text.length * FIRST_INTRO_MAX_SHARE)) return [];

  // Cut points: the start of the introducing sentence, or the separator just
  // before it when one sits in between.
  // With 2+ show headings the article is heading-structured: any OTHER heading
  // (a show we don't track, e.g. "VERY BLUE LIGHT") ends the section before it,
  // so its text is never folded into a tracked show's section.
  const headingStructured = headings.filter((h) => h.showId).length >= 2;
  const foreignHeads = headingStructured ? headings.filter((h) => !h.showId).map((h) => h.at) : [];
  const cuts = intros.map(({ at, heading }, i) => {
    if (i === 0) return 0;
    if (heading) return at;
    const sep = sepEnds.filter((e) => e <= at && at - e < 250).pop();
    return sep !== undefined ? sep : sentenceStart(text, at);
  });
  // Every later section must open a unit of the article: right after a
  // separator rule, at a paragraph start, or with its title leading the
  // sentence (capsule headers like "‘Fallen Angels’ For the most ..."). A
  // title quoted mid-paragraph is a comparison, not a new review.
  for (let i = 1; i < intros.length; i++) {
    if (intros[i].afterSeparator) continue;
    const before = text.slice(Math.max(0, cuts[i] - 3), cuts[i]);
    const paragraphStart = cuts[i] === 0 || /\n\s*$/.test(before);
    const titleLeads = intros[i].at - cuts[i] <= 3;
    if (!paragraphStart && !titleLeads) return [];
    // A new review names its show up front; a paragraph that only gets to a
    // title later ("At Sunday's opening ... the original 'Jitney' ensemble")
    // is colour inside the same review (Sweat/Showbiz411, BRO-4431 review).
    if (intros[i].at - cuts[i] > INTRO_LEAD_CHARS) return [];
  }

  // A section opens with its own listing block + lede when the column puts
  // them first (WSJ Teachout: "Music Box Theatre, / 239 W. 45th St. / ... /
  // Ken Ludwig writes comfy farces ..." then "'Lend Me a Tenor,' last seen
  // ..."): move the cut back over them so they leave the previous section
  // (BRO-5198 ship-check, the-addams-family-2010 / lend-me-a-tenor-2010).
  for (let i = 1; i < cuts.length; i++) {
    const back = listingLedStart(text, cuts[i], Math.max(cuts[i - 1], intros[i - 1].at));
    if (back !== null && countMatches(intros[i - 1].m.any, text.slice(back, cuts[i])) === 0) cuts[i] = back;
  }

  const sections = [];
  for (let i = 0; i < intros.length; i++) {
    let end = i + 1 < cuts.length ? cuts[i + 1] : text.length;
    const foreign = foreignHeads.find((a) => a > intros[i].at && a < end);
    if (foreign !== undefined) end = foreign;
    const raw = text.slice(cuts[i], end);
    sections.push({ m: intros[i].m, raw, sectionText: stripSeparators(raw), afterSeparator: intros[i].afterSeparator });
  }

  // Validation: every section is ABOUT its show and big enough.
  const total = text.length;
  for (const sec of sections) {
    const own = countMatches(sec.m.any, sec.raw);
    // A capsule set off by a rule may name its show once; a section found only
    // by a quoted mention must keep talking about that show (one quoted
    // comparison, e.g. Icke's "Oedipus" in a review of The Other Place, is
    // not a review of it).
    if (own < (sec.afterSeparator ? 1 : 2)) return [];
    // A section may not mention any other planned show at all: a review of
    // one show that compares it to another running show (The Crucible vs
    // van Hove's A View From the Bridge, BRO-4431 ship-check) names the
    // first show again after the comparison; real capsules do not.
    for (const other of sections) {
      if (other === sec) continue;
      if (countMatches(other.m.any, sec.raw) > 0) return [];
    }
    if (sec.sectionText.length < MIN_SECTION_CHARS) return [];
    if (!headingStructured && sec.sectionText.length / total < MIN_SECTION_SHARE) return [];
  }
  if (!sections.some((s) => s.m.show.id === ownShowId)) return [];

  return sections.map((s) => ({
    showId: s.m.show.id,
    showTitle: s.m.show.title,
    sectionText: s.sectionText,
    anchorKind: 'intro',
  }));
}

/**
 * Prose matcher for the joint strategy. Wider than buildShowMatcher: a
 * spaced-dash subtitle splits off ("ANON – a tempest at our kitchen table"
 * is called "Anon" in reviews), and single-word titles of 4+ letters count
 * ("Fish", "Midnight"). Every match must start with a capital letter, so
 * "midnight" or "two girls" in running prose is not a title. Common-word
 * titles stay unmatched.
 */
function buildJointMatcher(show) {
  const title = String(show.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const norm = normalizeTitle(title);
  if (COMMON_WORD_SHOW_TITLES.has(norm) || COMMON_WORD_SHOW_TITLES.has(title.toLowerCase())) return null;
  const variants = new Set(titleVariants(title));
  const dashMain = title.split(/\s+[–—-]\s+/)[0].trim();
  if (dashMain && dashMain !== title) variants.add(dashMain);
  const sources = [];
  for (const v of variants) {
    const vNorm = normalizeTitle(v);
    if (!vNorm || COMMON_WORD_SHOW_TITLES.has(vNorm)) continue;
    if (vNorm.split(' ').length === 1 && vNorm.length < 4) continue;
    const src = titleRegexSource(v);
    if (src) sources.push(src);
  }
  if (!sources.length) return null;
  return { show, re: new RegExp(`(?<![\\w’'])(?:${sources.join('|')})(?![\\w])`, 'gi') };
}

// Rating stars and list punctuation right after a title ("Fish ****, Anon").
const AFTER_TITLE_RE = /^[\s*★☆½,;:]+/;
// A bare web address followed by a space: the last line of a credits block.
const WEB_ADDRESS_RE = /(?<![\w@/.-])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|info|nyc|co\.uk|org\.uk)(?:\/[^\s]*)?(?=\s)/gi;
// What may follow a one-word title that opens a sentence for it to count:
// a star rating or a run listing ("Midnight Through Jan. 3 at ...").
const ONE_WORD_LEAD_OK_RE = /^\s*(?:[*★☆]|(?:Through|Until|Closes|Extended|is (?:at|playing|running|now))\b)/;

/**
 * Sorted [start, end) spans where the matcher's title appears capitalised. A
 * one-word title that opens a sentence ("Fish are ...", "Midnight came")
 * only counts when quoted, star-rated or followed by its run listing.
 */
function jointMentions(m, text) {
  const out = [];
  m.re.lastIndex = 0;
  let x;
  while ((x = m.re.exec(text))) {
    const lead = x[0].replace(/^the\s+/i, '');
    if (!/^[A-Z0-9]/.test(lead)) continue;
    const end = x.index + x[0].length;
    if (!/\s/.test(lead) && sentenceStart(text, x.index) === x.index
      && !/[“"‘']\s*$/.test(text.slice(Math.max(0, x.index - 2), x.index))
      && !ONE_WORD_LEAD_OK_RE.test(text.slice(end, end + 12))) continue;
    out.push({ id: m.show.id, at: x.index, end });
  }
  return out;
}
const LISTING_SNIPPET_MAX = 300;
const MAX_TAIL_SHARE = 0.25;
// What a closing listing line carries: a star rating, run dates, a venue,
// an address, tickets or a running time.
const LISTING_SIGNAL_RE = /[★☆*]|\b(?:through|until|closes|extended|thru|theat(?:er|re)|playhouse|stage|tickets?|running time|\d+ (?:hours?|minutes?|mins?)|\d+\s+[A-Z]\w*\.? (?:St|Street|Ave|Avenue|Pl|Place|Lane))\b/i;
const HEAD_ONLY_MIN_SHARE = 0.25;

// The reviewed show's cast and creative team, normalised: one-word names
// ("Sting") and, per surname, the given names that precede it.
function creditedNames(show) {
  const single = new Set();
  const given = new Map();
  for (const p of [...(show.cast || []), ...(show.creativeTeam || [])]) {
    const parts = normTitle((p && p.name) || '').split(' ').filter(Boolean);
    if (parts.length === 1) single.add(parts[0]);
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1];
    if (!given.has(last)) given.set(last, new Set());
    given.get(last).add(parts.slice(0, -1).join(' '));
  }
  return { single, given };
}

// A mention of a show titled after someone credited on the reviewed show
// that reads as that person: "Daniel Fish" or "Fish's staging".
function isCreditedPersonMention(text, mn, givenNames) {
  if (/^['’]s\b/.test(text.slice(mn.end, mn.end + 3))) return true;
  const before = normTitle(text.slice(Math.max(0, mn.at - 40), mn.at));
  for (const g of givenNames) if (before === g || before.endsWith(' ' + g)) return true;
  return false;
}

function normTitle(t) {
  return String(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Strategy 3: a joint review. One critic covers two or three shows in one
 * running piece (NYT "Midnight" + "The Curious Case of Benjamin Button",
 * Theater Life's Good Time Charlie / Fish / Anon, BRO-5895): the lede or a
 * header names every show, each show then gets one stretch of prose that never
 * names the others, and a closing block lists each show's run. Neither
 * captions nor a per-show introduction mark the joins, so the cut goes at the
 * sentence where the prose moves to the next show's title.
 *
 * Fails closed: every show needs 2+ mentions, its stretch must be the only
 * place it is discussed (all other mentions sit in the head before the first
 * stretch or the tail after the last), and either the tail (at most a
 * quarter of the text) lists every show, or the head names every show,
 * nothing follows the stretches, they run in the head's order and each is
 * at least a quarter of the text.
 * Each section keeps its stretch plus its own line of the closing listing
 * (where a capsule column puts its star rating). The shared head is dropped:
 * it can hold the other shows' verdicts and stars.
 */
function jointSections(text, shows, ownShowId, publishDate, opts = {}) {
  const ownShow = shows.find((s) => s.id === ownShowId) || null;
  if (!ownShow) return [];
  const pub = require('./date-utils').toDateMs(publishDate);
  if (!pub) return [];
  const ownOpen = Date.parse(ownShow.openingDate || ownShow.previewsStartDate || '');
  // A first-seen date stands in for a missing publish date only when the
  // file was found within weeks of its own show opening: an old article
  // ingested late would otherwise be read against this season's shows.
  const before = opts.dateIsFirstSeen ? WINDOW_AFTER_DAYS : WINDOW_BEFORE_DAYS;
  if (!ownOpen || ownOpen < pub - before * DAY_MS || ownOpen > pub + WINDOW_AFTER_DAYS * DAY_MS) return [];
  const cands = dedupeProductions(candidateShows(shows, ownShow, publishDate), ownShowId, publishDate);

  const people = creditedNames(ownShow);
  const normText = ` ${normTitle(text)} `;
  const byShow = new Map();
  for (const show of cands) {
    // Another show titled after someone credited on this one is that person,
    // not a second review: drop it outright for a one-word name ("Sting" for
    // The Last Ship), and drop the mentions that read as the person for a
    // surname ("Daniel Fish" directs Kramer/Fauci; "Fish" is also a show).
    const key = show.id === ownShowId ? '' : normTitle(show.title);
    if (people.single.has(key)) continue;
    // Once the piece names the person in full ("Daniel Fish"), a bare
    // surname later on ("Fish recreates...") is that person too (BRO-5942).
    if (people.given.has(key) && [...people.given.get(key)].some((g) => normText.includes(` ${g} ${key} `))) continue;
    const m = buildJointMatcher(show);
    if (!m) continue;
    let ms = jointMentions(m, text);
    if (people.given.has(key)) ms = ms.filter((mn) => !isCreditedPersonMention(text, mn, people.given.get(key)));
    if (ms.length >= 2) byShow.set(show.id, { show, mentions: ms });
  }
  if (byShow.size < 2 || !byShow.has(ownShowId)) return [];

  // One title inside another ("Fish" in "Big Fish") keeps the longer match.
  const all = [...byShow.values()].flatMap((v) => v.mentions)
    .sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  const kept = [];
  for (const mn of all) {
    if (kept.length && mn.at < kept[kept.length - 1].end) continue;
    kept.push(mn);
  }
  // A show whose mentions were all inside a longer title drops out, and the
  // 2-mention floor applies again to what survived.
  const survived = new Map();
  for (const mn of kept) survived.set(mn.id, (survived.get(mn.id) || 0) + 1);
  for (const id of [...byShow.keys()]) if ((survived.get(id) || 0) < 2) byShow.delete(id);
  if (byShow.size < 2 || !byShow.has(ownShowId)) return [];
  const mentions = kept.filter((mn) => byShow.has(mn.id));

  // Runs of consecutive mentions of one show.
  const runs = [];
  for (const mn of mentions) {
    const last = runs[runs.length - 1];
    if (last && last.id === mn.id) { last.lastEnd = mn.end; last.count++; continue; }
    runs.push({ id: mn.id, at: mn.at, lastEnd: mn.end, count: 1 });
  }
  runs.forEach((r, i) => { r.extent = (i + 1 < runs.length ? runs[i + 1].at : text.length) - r.at; });

  // Each show's stretch is its longest run; the stretches must sit side by side.
  const bodyIdx = [];
  for (const id of byShow.keys()) {
    let best = -1;
    runs.forEach((r, i) => { if (r.id === id && (best < 0 || r.extent > runs[best].extent)) best = i; });
    bodyIdx.push(best);
  }
  bodyIdx.sort((a, b) => a - b);
  for (let i = 1; i < bodyIdx.length; i++) if (bodyIdx[i] !== bodyIdx[i - 1] + 1) return [];
  const first = bodyIdx[0];
  const lastBody = bodyIdx[bodyIdx.length - 1];
  const head = runs.slice(0, first);
  const tail = runs.slice(lastBody + 1);
  // Either the tail lists every show, or (no tail at all) the head
  // introduces every show in the order their stretches run and each stretch
  // carries a real share of the piece: a single review whose lede compares
  // it to another show and which closes on a paragraph about that show is
  // not a joint review.
  const tailAll = new Set(tail.map((r) => r.id)).size === byShow.size;
  if (!tailAll) {
    if (tail.length) return [];
    const order = [];
    for (const r of head) if (!order.includes(r.id)) order.push(r.id);
    if (order.join() !== bodyIdx.map((i) => runs[i].id).join()) return [];
    // The last stretch runs to the end of the piece with nothing after it to
    // bound it, so one passing mention there is a closing aside, not a review.
    if (runs[bodyIdx[bodyIdx.length - 1]].count < 2) return [];
    // An earlier stretch named once must open on its title ("“Anon,” at MCC
    // Theater, is..."): a single mention inside a sentence about the other
    // show is a comparison ("unlike How to Dance in Ohio", BRO-5942).
    for (const i of bodyIdx) {
      if (runs[i].count < 2 && /[\p{L}\p{N}]/u.test(text.slice(sentenceStart(text, runs[i].at), runs[i].at))) return [];
    }
  }
  const minShare = tailAll ? MIN_SECTION_SHARE : HEAD_ONLY_MIN_SHARE;
  const cutAt = (runIdx) => {
    const r = runs[runIdx];
    const floor = runIdx > 0 ? runs[runIdx - 1].lastEnd : 0;
    let c = Math.max(sentenceStart(text, r.at), floor);
    if (c === floor && floor > 0) c += (text.slice(c).match(AFTER_TITLE_RE) || [''])[0].length;
    // A credits listing has no sentence end of its own ("...New York, NY
    // kingcharlesiiibroadway.com Keira Knightley in Thérèse Raquin"): its
    // web address ends it, so the cut goes after it and another show's
    // credits never open this section (Flipside, BRO-5942). Only a listing's
    // address counts: "fans who found it via Broadway.com will love X" keeps
    // its sentence whole.
    if (runIdx > 0) {
      const start = c;
      let m;
      WEB_ADDRESS_RE.lastIndex = start;
      while ((m = WEB_ADDRESS_RE.exec(text)) && m.index < r.at) {
        if (m.index + m[0].length <= r.at && LISTING_SIGNAL_RE.test(text.slice(start, m.index))) {
          c = m.index + m[0].length;
        }
      }
      while (c < r.at && /\s/.test(text[c])) c++;
    }
    return Math.min(c, r.at);
  };
  // With nothing before the first stretch, a second stretch that opens in
  // the sentence closing the first ("...Waiting for Godot," and Pinter's "No
  // Man's Land.") means the first stretch was only the opening that names
  // both shows: the review then interleaves them (BRO-5942). A transition
  // after a lede that already named them ("While Birthright explores...,
  // A Walk on the Moon...") is a real join.
  if (!head.length && bodyIdx.length > 1
    && sentenceStart(text, runs[bodyIdx[1]].at) < runs[bodyIdx[0]].lastEnd) return [];
  const cuts = bodyIdx.map(cutAt);
  if (cuts[0] > text.length * FIRST_INTRO_MAX_SHARE) return [];
  const bodyEnd = tail.length ? cutAt(lastBody + 1) : text.length;
  // The tail is a closing listing and page chrome, never a big share of the
  // piece: a single review that names the other show again near its end
  // would otherwise lose its own last paragraphs.
  if (text.length - bodyEnd > text.length * MAX_TAIL_SHARE) return [];

  const total = text.length;
  const sections = [];
  for (let i = 0; i < bodyIdx.length; i++) {
    const run = runs[bodyIdx[i]];
    const body = text.slice(cuts[i], i + 1 < cuts.length ? cuts[i + 1] : bodyEnd).trim();
    if (body.length < MIN_SECTION_CHARS || body.length / total < minShare) return [];
    // Its own line of the closing listing: from the title to the end of that
    // entry (a sentence end past 40 chars). A shared entry ("X and Y: Through
    // ...") stays whole; one that gives this show its own details before the
    // next show's title ("X ****, Y **") stops at that title.
    let listing = '';
    const tr = tail.find((r) => r.id === run.id);
    if (tr) {
      const from = tr.at;
      let to = Math.min(from + LISTING_SNIPPET_MAX, text.length);
      const stop = /[.!?](?=\s+[A-Z“"])/g;
      stop.lastIndex = from + 40;
      const s = stop.exec(text);
      if (s && s.index < to) to = s.index + 1;
      const entry = text.slice(from, to);
      // A closing sentence that merely names the shows again ("Fans of X
      // should go") is the review's own ending, not a listing.
      if (tailAll && !LISTING_SIGNAL_RE.test(entry)) return [];
      const nextTitle = mentions.find((mn) => mn.at > from && mn.at < to && mn.id !== run.id);
      if (nextTitle && LISTING_SIGNAL_RE.test(text.slice(tr.lastEnd, nextTitle.at))) to = nextTitle.at;
      listing = text.slice(from, to).trim().replace(/[\s,;“"]+$/, '');
    }
    sections.push({
      showId: run.id,
      showTitle: byShow.get(run.id).show.title,
      sectionText: listing ? `${body}\n\n${listing}` : body,
      anchorKind: 'joint',
    });
  }
  return sections;
}

// "How Shakespeare Saved My Life is at the Public Theater through October 25."
const RUN_LISTING_RE = /[^.!?\n]{0,160}\bis (?:at|playing at|running at|now at|in performance at)\b[^.!?\n]{0,120}\b(?:through|until|to)\b[^.!?\n]{0,60}\.?/gi;

/**
 * True when a caption section names another section's show. Photo captions
 * mark where a picture sits, not where one review ends: an essay that moves
 * between two shows (Vulture's How Shakespeare Saved My Life / Arias With a
 * Twist, BRO-4431) has both captions inside running text, and cutting at
 * them filed half of each review under the other show. The intro strategy
 * has the same rule. Closing run listings ("X is at ... through ...") are
 * ignored.
 */
function captionSectionsCrossTalk(sections, shows) {
  const byId = new Map(shows.map((sh) => [sh.id, sh]));
  const matchers = new Map();
  for (const sec of sections) {
    const show = byId.get(sec.showId);
    const m = show && buildShowMatcher(show);
    if (m) matchers.set(sec.showId, m);
  }
  for (const sec of sections) {
    const body = String(sec.sectionText || '').replace(RUN_LISTING_RE, ' ');
    for (const [id, m] of matchers) {
      if (id === sec.showId) continue;
      if (countMatches(m.any, body) > 0) return true;
    }
  }
  return false;
}

/**
 * The joint strategy is on by default after a corpus-wide dry run (BRO-5895).
 * opts.joint=false or MULTI_SHOW_JOINT=0 turns it off for new splits; a
 * parent it already split still re-trims with it.
 */
function jointEnabled(opts, data) {
  // A parent the joint strategy split re-trims the same way, or a refetch
  // that puts the whole article back would leave it holding every section.
  if (data && data.multiShowSplitParent === true && data.multiShowSplitAnchorKind === 'joint') return true;
  if (typeof opts.joint === 'boolean') return opts.joint;
  return process.env.MULTI_SHOW_JOINT !== '0';
}

/**
 * Plan the fan-out for one review file's data. Pure (shows passed in).
 * Returns null when the text is not a multi-show article, else
 * { ownSection, otherSections, strategy }.
 */
function planMultiShowFanout(data, shows, opts = {}) {
  if (!data || typeof data !== 'object') return null;
  if (data.multiShowSplitChild) return null;
  // An undone split stays whole (a later heuristic change must not re-cut it).
  if (data.multiShowUnsplitAt) return null;
  // A column whose sections were filed by copy-multishow-section.js (BRO-5325)
  // stays whole: the scorer reads its own section at score time (BRO-5294),
  // and this planner's intro cut lands elsewhere in WSJ capsule columns.
  if (data.multiShowSplitMethod === 'venue-box') return null;
  if (data.multiShowSplitProcessed) {
    const retrimmed = data.multiShowSplitParent && typeof data.fullText === 'string'
      && Number.isFinite(data.multiShowSplitTextLength)
      && data.fullText.length > data.multiShowSplitTextLength + 200;
    if (!retrimmed) return null;
  }
  // Aggregator round-ups quote many critics; they are not one critic's review.
  if (data.isRoundupArticle) return null;
  if (data.wrongProduction === true) return null;
  // A duplicate record of another file splits with that file, not again
  // under its own critic slot (BRO-5942: Theater Life "--unknown" copies).
  if (data.duplicateOf) return null;
  if (PARTIAL_TIERS.has(data.contentTier)) return null;
  if (data.contentTier === 'invalid' && !/wrong\s*show|multi[\s-]?show/i.test(data.contentTierReason || '')) return null;
  const text = data.fullText;
  if (typeof text !== 'string' || text.length < MIN_TEXT_CHARS) return null;
  const ownShowId = opts.ownShowId || data.showId;
  if (!ownShowId) return null;
  const showIds = new Set(shows.map((s) => s.id));

  let strategy = 'caption';
  let sections = splitMultiShowArticle(text, shows).filter((s) => showIds.has(s.showId));
  // Captions already showed one essay moving between the shows (BRO-4431):
  // no later strategy may cut it either.
  const interwoven = sections.length >= 2 && captionSectionsCrossTalk(sections, shows);
  if (interwoven) sections = [];
  if (sections.length < 2 || !sections.some((s) => s.showId === ownShowId)) {
    strategy = 'intro';
    sections = introSections(text, shows, ownShowId, data.publishDate);
  }
  if (sections.length < 2 && !interwoven && jointEnabled(opts, data)) {
    strategy = 'joint';
    sections = jointSections(text, shows, ownShowId, data.publishDate || data.firstSeenAt, { dateIsFirstSeen: !data.publishDate });
  }
  if (sections.length < 2) return null;
  // The last section carries the page footer (newsletter/subscribe chrome).
  const { stripTrailingJunk } = require('./text-cleaning');
  sections = sections.map((sec) => ({ ...sec, sectionText: stripTrailingJunk(sec.sectionText) || sec.sectionText }));
  const ownSection = sections.find((s) => s.showId === ownShowId);
  if (!ownSection) return null;
  const otherSections = sections.filter((s) => s.showId !== ownShowId);
  return { ownSection, otherSections, strategy };
}

function wordCount(s) {
  return String(s || '').split(/\s+/).filter(Boolean).length;
}

function rewriteParent(data, ownSection, childShowIds, now = new Date().toISOString()) {
  const out = { ...data };
  out.fullText = ownSection.sectionText;
  out.wordCount = wordCount(ownSection.sectionText);
  out.textWordCount = out.wordCount;
  out.multiShowSplitProcessed = now;
  out.multiShowSplitParent = true;
  out.multiShowSplitChildShowIds = childShowIds;
  out.multiShowSplitAnchorKind = ownSection.anchorKind;
  out.multiShowSplitOriginalLength = (data.fullText || '').length;
  // Lets the planner notice a later re-collection that put the whole article
  // back into fullText (the processed marker survives merges) and re-trim.
  out.multiShowSplitTextLength = out.fullText.length;

  // A rating an LLM read off the whole multi-show article may be another
  // show's: the Observer's Plaza Suite row carried Till the Stars Come Down's
  // 4/5, and the rebuild ranks a stored rating above every score (BRO-5942).
  if (out.originalScore != null && /^llm/i.test(String(out.originalScoreSource || ''))) {
    require('./verified-original-score').applyVerifiedOriginalScore(out, null,
      'multi-show split: an LLM read this rating from the whole multi-show article (BRO-5942)');
  }

  // Clear wrongShow if it was set for being a multi-show roundup — the file's
  // text is now just its own show's section. Preserve any manual review state.
  const humanVerdict = /manual|human|owner|admin/i.test(`${out.rejectedBy || ''} ${out.wrongShowSource || ''}`);
  if (out.wrongShow === true && !out.wrongShowManualClear && !out.wrongShowOverride && !humanVerdict) {
    delete out.wrongShow;
    delete out.wrongShowReason;
    delete out.rejectedAt;
    delete out.rejectedBy;
    delete out.rejectionReason;
    delete out.rejectionReasoning;
    out.wrongShowClearedBy = 'multi-show-splitter';
    out.wrongShowClearedAt = now;
  }

  // The file is now SINGLE-show after trimming — clear isMultiShowReview so
  // the LLM-scoring trim/skip path doesn't re-trim already-trimmed text.
  if (out.isMultiShowReview === true) {
    delete out.isMultiShowReview;
    delete out.multiShowReason;
    out.multiShowReviewClearedBy = 'multi-show-splitter';
  }

  // contentTier was likely 'invalid' from a wrongShow rejection — the trimmed
  // text is a valid single-show section now. Only override invalid-with-
  // wrong-show-reason; preserve genuine truncated/stub/manual verdicts.
  if (out.contentTier === 'invalid' && /wrong\s*show|multi[\s-]?show/i.test(out.contentTierReason || '')) {
    out.contentTier = 'complete';
    out.contentTierReason = 'multi-show-split: trimmed to own show section';
  }

  // Always re-score after a split — the trimmed text is materially different
  // from whatever was scored before (or unscored). A critic-published
  // originalScore stays on the parent (the file the article was filed under),
  // unless an LLM extracted it (cleared above), and is never copied to
  // children: it can't be attributed to one section.
  require('./rescore-flagging').markRescoreNeeded(out, out.rescoreReason || 'multi-show-split: text trimmed to own section', now, { requeue: true });
  out.needsRescoreReason = 'multi-show-split: text trimmed to own section';
  delete out.ensembleData;
  delete out.llmScore;
  return out;
}

function buildChild(parentData, section, parentShowId, now = new Date().toISOString()) {
  const child = {
    showId: section.showId,
    outletId: parentData.outletId,
    outlet: parentData.outlet,
    criticName: parentData.criticName,
    url: parentData.url,
    publishDate: parentData.publishDate,
    fullText: section.sectionText,
    source: 'multi-show-split',
    contentTier: 'complete',
    contentTierReason: `Split from multi-show review originally filed under ${parentShowId}`,
    wordCount: wordCount(section.sectionText),
    isFullReview: true,
    textStatus: 'complete',
    textQuality: 'full',
    multiShowSplitChild: true,
    multiShowSplitParentShowId: parentShowId,
    multiShowSplitAnchorKind: section.anchorKind,
    multiShowSplitProcessed: now,
    needsRescoreReason: 'multi-show-split: new child file, awaiting scoring',
  };
  if (parentData.textFetchedAt) child.textFetchedAt = parentData.textFetchedAt;
  if (parentData.firstSeenAt) child.firstSeenAt = parentData.firstSeenAt;
  child.textWordCount = child.wordCount;
  require('./rescore-flagging').markRescoreNeeded(child, child.needsRescoreReason, now);
  return child;
}

/**
 * An existing file at the child path blocks the write unless it is a textless
 * stub for the SAME article (e.g. a discovery stub the listing poller filed),
 * in which case the section text fills it.
 */
// One article whatever its scheme, www prefix, query, hash or trailing slash.
function urlKey(u) {
  return String(u).trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
    .replace(/^https?:\/\/(?:www\.)?/i, '').replace(/^[^/]+/, (h) => h.toLowerCase());
}

function childWriteDecision(existing, parentData) {
  if (!existing) return 'create';
  const sameUrl = existing.url && parentData.url && urlKey(existing.url) === urlKey(parentData.url);
  const textless = !existing.fullText || String(existing.fullText).length < 300;
  if (sameUrl && textless) return 'fill';
  // An empty placeholder with no URL at this outlet--critic slot, unless a
  // person or a guard already judged it (lock, hand score, exclusion flag).
  const judged = existing._locked || existing.humanReviewScore != null || existing.originalScore != null || existing.manualContentTier
    || existing.wrongShow || existing.wrongProduction || existing.isNonReview || existing.duplicateOf
    || existing.isRoundupArticle;
  if (!existing.url && textless && !judged) return 'fill';
  // The same article already filed under that show (e.g. the original
  // parent when this section was re-ingested under another show).
  if (sameUrl) return 'held';
  return 'skip';
}

// Whether a fan-out result moves any text: some sibling section is written or
// already held. When every sibling slot holds a different review, apply
// leaves the article whole, so a dry run must not count it as splittable.
function fanoutMovesText(fan) {
  return !!(fan && fan.applied && fan.children.some((c) => c.action === 'create' || c.action === 'fill' || c.action === 'held'));
}

/**
 * Apply the fan-out to a file on disk. `reviewTextsDir` is the root holding
 * {showId}/ dirs. Returns { applied, parentRewritten, children: [{showId, action}] }.
 * With dryRun nothing is written.
 */
function applyMultiShowFanoutToFile(filePath, opts = {}) {
  const shows = opts.shows || loadShows();
  const reviewTextsDir = opts.reviewTextsDir || path.dirname(path.dirname(filePath));
  const dryRun = !!opts.dryRun;
  const result = { applied: false, parentRewritten: false, children: [], strategy: null };
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return result; }
  const ownShowId = data.showId || path.basename(path.dirname(filePath));
  const plan = planMultiShowFanout(data, shows, { ownShowId, joint: opts.joint });
  if (!plan) {
    if (!dryRun && isWholeArticleBackOnBadSplit(data, shows)) {
      result.unsplit = unsplitArticle(filePath, data, reviewTextsDir, ownShowId);
    }
    return result;
  }
  result.applied = true;
  result.strategy = plan.strategy;
  const now = new Date().toISOString();
  const fileName = path.basename(filePath);

  const { loadBlocklist, findBlockedEntry } = require('./poller-blocklist');
  const { safeWriteReview } = require('./review-write-guard');
  let written = 0;
  let held = 0;
  for (const sec of plan.otherSections) {
    const childDir = path.join(reviewTextsDir, sec.showId);
    const childPath = path.join(childDir, fileName);
    let existing = null;
    if (fs.existsSync(childPath)) {
      try { existing = JSON.parse(fs.readFileSync(childPath, 'utf8')); } catch { existing = { unreadable: true }; }
    }
    // An operator-deleted URL (poller-blocklist, BRO-3247 class) stays deleted.
    let decision = data.url && findBlockedEntry(loadBlocklist(childDir), data.url) ? 'blocked' : childWriteDecision(existing, data);
    result.children.push({ showId: sec.showId, action: decision, chars: sec.sectionText.length });
    if (decision === 'held') { held++; continue; }
    if (dryRun || decision === 'skip' || decision === 'blocked') continue;
    const child = buildChild(data, sec, ownShowId, now);
    // A 3-show article's children name each other, so the URL-ownership guard
    // treats every section as one review filed per show (BRO-5895).
    const siblings = plan.otherSections.map((o) => o.showId).filter((id) => id !== sec.showId);
    if (siblings.length) child.multiShowSplitSiblingShowIds = siblings;
    // A filled stub keeps its discovery source but records where its text came
    // from (BRO-5325: a web-search-only stub stays unscoreable otherwise).
    const toWrite = decision === 'fill'
      ? { ...existing, ...child, source: existing.source || child.source, publishDate: child.publishDate || existing.publishDate, sources: [...new Set([].concat(existing.sources || [], existing.source || [], 'multi-show-split').filter(Boolean))] }
      : child;
    fs.mkdirSync(childDir, { recursive: true });
    const w = safeWriteReview(childPath, toWrite);
    if (w && w.wrote !== false) written++;
    else result.children[result.children.length - 1].action = `refused:${(w && w.skipped) || 'write-guard'}`;
  }

  // Only trim the parent when another section now lives somewhere: written
  // in this run, or the same article already held under that show (a
  // section re-ingested after its sibling was split earlier). When every
  // sibling slot holds a DIFFERENT review (or was refused), the article stays
  // whole rather than losing text no file holds.
  if (!dryRun && written + held === 0) return result;
  const parent = rewriteParent(data, plan.ownSection, plan.otherSections.map((s) => s.showId), now);
  result.parentRewritten = true;
  // Deliberate text trim: replace (not merge) so the stale whole-article
  // llmScore/ensembleData really go; the guard's other checks still apply.
  if (!dryRun) safeWriteReview(filePath, parent, { merge: false, force: true });
  return result;
}

/**
 * A split parent whose fullText is the whole article again (a re-ingest put
 * it back) but whose article no longer plans as a split: the earlier split
 * was wrong (BRO-4431 Vulture caption split).
 */
function isWholeArticleBackOnBadSplit(data, shows) {
  if (!(data && data.multiShowSplitParent === true && typeof data.fullText === 'string'
    && Number.isFinite(data.multiShowSplitTextLength)
    && data.fullText.length > data.multiShowSplitTextLength + 200)) return false;
  // Never on a record a human or another verdict owns.
  if (data._locked === true || data.manualContentTier || data.humanReviewScore != null
    || data.wrongProduction === true || data.isRoundupArticle === true || data.duplicateOf) return false;
  // Positive evidence only: the article's caption sections exist and cross-
  // talk. A planner null for any other reason (partial tier, a show missing
  // from the catalogue) must not undo a correct split.
  const showIds = new Set(shows.map((s) => s.id));
  const sections = splitMultiShowArticle(data.fullText, shows).filter((s) => showIds.has(s.showId));
  return sections.length >= 2 && captionSectionsCrossTalk(sections, shows);
}

const SPLIT_FIELDS = [
  'multiShowSplitProcessed', 'multiShowSplitParent', 'multiShowSplitChild',
  'multiShowSplitChildShowIds', 'multiShowSplitParentShowId', 'multiShowSplitAnchorKind',
  'multiShowSplitSiblingShowIds',
  'multiShowSplitOriginalLength', 'multiShowSplitTextLength',
];

/**
 * Undo a wrong split: the parent keeps the whole article it now holds, and a
 * child this split created (still flagged as its child) gets the whole
 * article too, since its section was cut at the same wrong point. Both are
 * re-scored. Children that hold anything else are left alone.
 */
function unsplitArticle(filePath, data, reviewTextsDir, ownShowId) {
  const { safeWriteReview } = require('./review-write-guard');
  const now = new Date().toISOString();
  const allShows = [ownShowId, ...(data.multiShowSplitChildShowIds || [])];
  const strip = (rec) => {
    const out = { ...rec };
    for (const k of SPLIT_FIELDS) delete out[k];
    out.multiShowUnsplitAt = now;
    // The established joint-review marker (flag-combined-reviews.js): every
    // cross-show URL check treats the copies as one article.
    out.isCombinedReview = true;
    out.combinedWith = allShows.filter((id) => id !== out.showId);
    require('./rescore-flagging').markRescoreNeeded(out, out.rescoreReason || 'multi-show-split undone: article is one essay about both shows', now, { requeue: true });
    out.needsRescoreReason = 'multi-show-split undone: article is one essay about both shows';
    delete out.ensembleData;
    delete out.llmScore;
    return out;
  };
  const children = [];
  for (const childShowId of data.multiShowSplitChildShowIds || []) {
    const childPath = path.join(reviewTextsDir, childShowId, path.basename(filePath));
    let child;
    try { child = JSON.parse(fs.readFileSync(childPath, 'utf8')); } catch { continue; }
    const { multiShowSplitGroup } = require('./multi-show-split-group');
    const sameArticle = !!data.url && child.url
      && multiShowSplitGroup({ ...child, multiShowSplitChild: true }) === multiShowSplitGroup(data);
    if (child._locked === true || child.manualContentTier || child.humanReviewScore != null) continue;
    if (child.isRoundupArticle === true || child.wrongProduction === true || child.duplicateOf) continue;
    if (child.multiShowSplitChild !== true || child.multiShowSplitParentShowId !== ownShowId) {
      // Already holds the whole article unsplit (re-ingested under its show):
      // mark it joint too, text unchanged.
      if (sameArticle && child.isCombinedReview !== true && child.wrongProduction !== true && !child.duplicateOf) {
        safeWriteReview(childPath, { ...child, isCombinedReview: true, combinedWith: allShows.filter((id) => id !== child.showId) }, { merge: false, force: true });
        children.push(childShowId);
      }
      continue;
    }
    const next = strip(child);
    next.fullText = data.fullText;
    safeWriteReview(childPath, next, { merge: false, force: true });
    children.push(childShowId);
  }
  safeWriteReview(filePath, strip(data), { merge: false, force: true });
  return { children };
}

module.exports = {
  fanoutMovesText,
  urlKey,
  planMultiShowFanout,
  captionSectionsCrossTalk,
  isWholeArticleBackOnBadSplit,
  applyMultiShowFanoutToFile,
  introSections,
  jointSections,
  buildJointMatcher,
  rewriteParent,
  buildChild,
  childWriteDecision,
  candidateShows,
  dedupeProductions,
  buildShowMatcher,
  MIN_SECTION_CHARS,
  MIN_SECTION_SHARE,
};
