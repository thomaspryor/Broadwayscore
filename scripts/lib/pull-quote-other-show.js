/**
 * pull-quote-other-show (BRO-8326): a pull quote must come from the part of the
 * article that is about THIS show.
 *
 * Reported 2026-11-25 on Come From Away: the Village Voice quote ("Buloff's
 * comedy was gigantic; DeVito's feisty ...") is Feingold's paragraph on The
 * Price, written in the same column; the Out Magazine quote ("Friday night at
 * the Triad, his TransAtlantic Dame show ...") is a drag-act item that opens a
 * Musto column whose Come From Away blurb starts 3,900 characters later. Both
 * reviews are real Come From Away coverage, so only the displayed quote is
 * wrong. The older guards (quoteOutsideTargetSection, combinedColumnQuoteLacksOwnShow)
 * cover asterisk-split columns and files flagged isCombinedReview; neither
 * sees a column split by headings or a news column with a blurb in it.
 *
 * Two tests, both on positive evidence from data we already hold. A 2026-11-25
 * sweep of 50,375 stored quotes showed looser versions (a quote that merely
 * follows a mention of another title, or opens before the show is named) hit
 * ordinary reviews that compare to other plays or open with a general lede,
 * so each test is narrow on purpose:
 *   1. OTHER SHOW: the column names another show that opened within
 *      WINDOW_DAYS of the review, and the quote names one of that show's
 *      performers (or full cast name) and nobody from this show, within
 *      SECTION_CHARS after that other show's title.
 *   2. BEFORE THE SHOW: a record already classed isNonReview (a news column
 *      or profile that only counts through an aggregator blurb) whose quote
 *      sits more than FAR_BEFORE_CHARS ahead of the first mention of this show.
 *
 * Pure (CLAUDE.md §15): callers may pass the evidence index; the only I/O is the
 * lazy data/shows.json read in loadDefaultIndex().
 */

const FAR_BEFORE_CHARS = 1200;
const SECTION_CHARS = 1800;
const WINDOW_DAYS = 150;

const fold = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]|--/g, '-')
  .replace(/\s+/g, ' ');

/**
 * Names that count as evidence for a show. Cast: full names and surnames of 6+
 * letters. Creative team: full names and, with creativeSurnames=true, surnames;
 * creativeSurnames=null leaves the creative team out. A director or writer
 * recurs across shows (Jamie Lloyd, Sondheim, Warchus), so the OTHER-show test
 * reads only performers.
 */
function showNames(show, { creativeSurnames = true } = {}) {
  const out = new Set();
  const add = (m, surnames) => {
    const name = fold(m && typeof m === 'object' ? m.name : m).trim();
    const parts = name.split(' ').filter(Boolean);
    if (parts.length < 2) return;
    out.add(name);
    const sur = parts[parts.length - 1];
    if (surnames && sur.length >= 6 && /^[A-Z]/.test(sur)) out.add(sur);
  };
  for (const m of (show && show.cast) || []) add(m, true);
  if (creativeSurnames !== null) for (const m of (show && show.creativeTeam) || []) add(m, creativeSurnames);
  return out;
}

function distinctiveTitle(title) {
  const t = fold(title).trim();
  if (!t) return null;
  // One short word ("Sweat", "Hir", "Gypsy", "Company") also reads as plain prose or an outlet name.
  if (t.split(' ').length < 2 && t.length < 8) return null;
  return t;
}

/**
 * @param {Array<{id:string,title:string,openingDate?:string,cast?:any[],creativeTeam?:any[]}>} shows
 * @returns {Array<{id:string,title:string,titleKey:string,opening:number|null,names:Set<string>}>}
 */
function buildEvidenceIndex(shows) {
  const out = [];
  for (const s of shows || []) {
    const titleKey = distinctiveTitle(s && s.title);
    if (!titleKey) continue;
    const opening = s.openingDate ? Date.parse(s.openingDate) : NaN;
    out.push({ id: s.id, title: s.title, titleKey, titleLower: titleKey.toLowerCase(), opening: Number.isFinite(opening) ? opening : null, names: showNames(s, { creativeSurnames: null }) });
  }
  return out;
}

let _defaultIndex = null;
let _showsById = null;
let _loadedPath = null;
// Fail open: a missing or unreadable data/shows.json must not abort a rebuild or
// an extractor run; the guard then just has no cross-show evidence. The path is
// resolved per call (SHOWS_JSON_PATH, BRO-8107) so a test can point it at a fixture.
function loadShows() {
  const file = require('./shows-json-path').showsJsonPath();
  if (_showsById && _loadedPath === file) return _showsById;
  _loadedPath = file;
  _showsById = new Map();
  let list = [];
  try {
    const raw = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    list = Array.isArray(raw) ? raw : (raw.shows || Object.values(raw));
  } catch (e) {
    console.warn(`[pull-quote-other-show] ${file} unreadable (${e.code || e.message}); other-show guard has no evidence`);
  }
  for (const sh of list) if (sh && sh.id) _showsById.set(sh.id, sh);
  _defaultIndex = buildEvidenceIndex(list);
  return _showsById;
}

function loadDefaultIndex() {
  loadShows();
  return _defaultIndex;
}

/** The full show record (cast, creative team) for an id, or null. Lets every caller judge a record with the same evidence. */
function lookupShow(id) {
  return (id && loadShows().get(id)) || null;
}

/** Whole-word positions of `needle` in `text`. */
function positionsOf(text, needle, caseSensitive) {
  const out = [];
  if (!needle) return out;
  const hay = caseSensitive ? text : text.toLowerCase();
  const nd = caseSensitive ? needle : needle.toLowerCase();
  let i = hay.indexOf(nd);
  while (i !== -1) {
    const before = i === 0 ? ' ' : text[i - 1];
    const after = i + nd.length >= text.length ? ' ' : text[i + nd.length];
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) out.push(i);
    i = hay.indexOf(nd, i + nd.length);
  }
  return out;
}

function stripWrap(q) {
  return fold(q).replace(/^[\s"'(\[]+|[\s"')\]]+$/g, '').replace(/…/g, '...');
}

function locateQuote(text, q) {
  if (!q) return -1;
  const first = q.split(/\s*\.\.\.\s*/)[0];
  if (!first || first.length < 12) return -1;
  const lc = text.toLowerCase();
  const usable = lc.length === text.length;
  return (usable ? lc : text).indexOf(usable ? first.toLowerCase() : first);
}

// Folding the text and finding the co-article shows costs a pass over the whole
// show index, and the rebuild asks about several candidate quotes per review.
const _articleCache = new WeakMap();

// "Rent" must not hide "Current": nested titles count only on whole words.
function sameOrNestedTitle(a, b) {
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function articleContext(data, show, index, ownKey) {
  const showId = (show && show.id) || data.showId || '';
  const hit = _articleCache.get(data);
  if (hit && hit.src === data.fullText && hit.showId === showId && hit.index === index) return hit;
  const text = fold(data.fullText);
  const ownTitleLower = ownKey.toLowerCase();
  const reviewDate = Date.parse(data.publishDate || '');
  const others = [];
  if (Number.isFinite(reviewDate)) {
    for (const o of index || loadDefaultIndex()) {
      if (o.id === showId || o.opening === null) continue; // no date evidence: not a "same time" show
      const ok = o.titleLower;
      if (sameOrNestedTitle(ok, ownTitleLower)) continue;
      if (Math.abs(o.opening - reviewDate) > WINDOW_DAYS * 864e5) continue;
      if (!positionsOf(text, o.titleKey, true).length) continue;
      others.push(o);
    }
  }
  const entry = { src: data.fullText, showId, index, text, others };
  _articleCache.set(data, entry);
  return entry;
}

/**
 * @param {string} quote
 * @param {{fullText?:string, publishDate?:string, showTitle?:string, showId?:string, isNonReview?:boolean}} data the review-texts record
 * @param {{id?:string,title?:string,cast?:any[],creativeTeam?:any[]}} show
 * @param {Array} [index] buildEvidenceIndex() of every show; defaults to data/shows.json
 * @returns {null | {rule:'other-show'|'before-show', detail:string}}
 */
function quoteInOtherShowPassage(quote, data, show, index) {
  if (!quote || !data || typeof data.fullText !== 'string' || data.fullText.length < 400) return null;
  const title = (show && show.title) || data.showTitle;
  const ownKey = distinctiveTitle(title) || fold(title).trim();
  if (!ownKey) return null;
  const { text, others } = articleContext(data, show, index, ownKey);
  const q = stripWrap(quote);
  if (!q) return null;
  const qLower = q.toLowerCase();

  const ownNames = showNames(show || {});
  const ownTitleLower = ownKey.toLowerCase();
  const ownBare = ownTitleLower.replace(/^(?:the|a|an) /, '');
  const ownPositions = new Set();
  for (const n of [ownTitleLower, ownBare]) for (const p of positionsOf(text, n, false)) ownPositions.add(p);
  for (const n of ownNames) for (const p of positionsOf(text, n, true)) ownPositions.add(p);
  const own = [...ownPositions].sort((a, b) => a - b);

  const qStart = locateQuote(text, q);
  const quoteHasOwn = qLower.includes(ownBare) || [...ownNames].some((n) => positionsOf(q, n, true).length);

  // --- Test 1: another show that opened at the same time is named in this column.
  if (others.length && !quoteHasOwn) {
    for (const o of others) {
      const named = [...o.names].filter((n) => !ownNames.has(n)).find((n) => positionsOf(q, n, true).length);
      if (!named) continue;
      // The other show's title must lead into the quote: a performer's name in a
      // review of this show can be a comparison, a title heading cannot.
      // A quote we cannot place in the article has no position, so a performer's
      // name alone (a comparison, say) is not enough to reject it.
      if (qStart < 0) continue;
      const heads = positionsOf(text, o.titleKey, true).filter((p) => p < qStart && qStart - p <= SECTION_CHARS);
      if (!heads.length) continue;
      const lead = Math.max(...heads);
      if (!own.some((p) => p > lead && p < qStart)) return { rule: 'other-show', detail: `names "${named}" in the ${o.title} section` };
    }
  }

  // --- Test 2: a news column or profile, quote far ahead of this show.
  if (data.isNonReview === true && qStart >= 0 && own.length && !quoteHasOwn) {
    const firstOwn = own[0];
    if (qStart + q.length < firstOwn && firstOwn - qStart > FAR_BEFORE_CHARS) {
      return { rule: 'before-show', detail: `quote ends ${firstOwn - (qStart + q.length)} chars before the first mention of ${title}` };
    }
  }
  return null;
}

module.exports = {
  quoteInOtherShowPassage, buildEvidenceIndex, loadDefaultIndex, lookupShow,
  FAR_BEFORE_CHARS, SECTION_CHARS, WINDOW_DAYS,
};
