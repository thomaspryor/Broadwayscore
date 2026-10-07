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
 * ingest-review-from-url.js) and by the split-multi-show-roundups.js backfill.
 *
 * Two strategies, first hit wins:
 *   1. caption  — multi-show-splitter.splitMultiShowArticle (unchanged).
 *   2. intro    — find where each in-window show is INTRODUCED (quoted title,
 *                 or the title right after a separator rule / at the start),
 *                 cut at the start of that sentence, then require every
 *                 section to be about its own show: it names its show more
 *                 often than any other planned show, is >= MIN_SECTION_CHARS
 *                 and >= MIN_SECTION_SHARE of the article.
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
 * Plan the fan-out for one review file's data. Pure (shows passed in).
 * Returns null when the text is not a multi-show article, else
 * { ownSection, otherSections, strategy }.
 */
function planMultiShowFanout(data, shows, opts = {}) {
  if (!data || typeof data !== 'object') return null;
  if (data.multiShowSplitChild) return null;
  // An undone split stays whole (a later heuristic change must not re-cut it).
  if (data.multiShowUnsplitAt) return null;
  if (data.multiShowSplitProcessed) {
    const retrimmed = data.multiShowSplitParent && typeof data.fullText === 'string'
      && Number.isFinite(data.multiShowSplitTextLength)
      && data.fullText.length > data.multiShowSplitTextLength + 200;
    if (!retrimmed) return null;
  }
  // Aggregator round-ups quote many critics; they are not one critic's review.
  if (data.isRoundupArticle) return null;
  if (data.wrongProduction === true) return null;
  if (PARTIAL_TIERS.has(data.contentTier)) return null;
  if (data.contentTier === 'invalid' && !/wrong\s*show|multi[\s-]?show/i.test(data.contentTierReason || '')) return null;
  const text = data.fullText;
  if (typeof text !== 'string' || text.length < MIN_TEXT_CHARS) return null;
  const ownShowId = opts.ownShowId || data.showId;
  if (!ownShowId) return null;
  const showIds = new Set(shows.map((s) => s.id));

  let strategy = 'caption';
  let sections = splitMultiShowArticle(text, shows).filter((s) => showIds.has(s.showId));
  if (sections.length >= 2 && captionSectionsCrossTalk(sections, shows)) sections = [];
  if (sections.length < 2 || !sections.some((s) => s.showId === ownShowId)) {
    strategy = 'intro';
    sections = introSections(text, shows, ownShowId, data.publishDate);
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
  // originalScore stays on the parent (the file the article was filed under)
  // and is never copied to children: it can't be attributed to one section.
  out.needsRescore = true;
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
    needsRescore: true,
    needsRescoreReason: 'multi-show-split: new child file, awaiting scoring',
  };
  if (parentData.textFetchedAt) child.textFetchedAt = parentData.textFetchedAt;
  if (parentData.firstSeenAt) child.firstSeenAt = parentData.firstSeenAt;
  child.textWordCount = child.wordCount;
  return child;
}

/**
 * An existing file at the child path blocks the write unless it is a textless
 * stub for the SAME article (e.g. a discovery stub the listing poller filed),
 * in which case the section text fills it.
 */
function childWriteDecision(existing, parentData) {
  if (!existing) return 'create';
  const sameUrl = existing.url && parentData.url
    && String(existing.url).replace(/[?#].*$/, '').replace(/\/$/, '') === String(parentData.url).replace(/[?#].*$/, '').replace(/\/$/, '');
  const textless = !existing.fullText || String(existing.fullText).length < 300;
  if (sameUrl && textless) return 'fill';
  // The same article already filed under that show (e.g. the original
  // parent when this section was re-ingested under another show).
  if (sameUrl) return 'held';
  return 'skip';
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
  const plan = planMultiShowFanout(data, shows, { ownShowId });
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
    const toWrite = decision === 'fill' ? { ...existing, ...child, source: existing.source || child.source } : child;
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
    out.needsRescore = true;
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
  planMultiShowFanout,
  captionSectionsCrossTalk,
  isWholeArticleBackOnBadSplit,
  applyMultiShowFanoutToFile,
  introSections,
  rewriteParent,
  buildChild,
  childWriteDecision,
  candidateShows,
  dedupeProductions,
  buildShowMatcher,
  MIN_SECTION_CHARS,
  MIN_SECTION_SHARE,
};
