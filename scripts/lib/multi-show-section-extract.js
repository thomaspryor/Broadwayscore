/**
 * Section extraction for single-blog-post, multi-show reviews (BRO-4387).
 *
 * theinterestedbystander.com (Cary Wong) reviews several shows per post. Each
 * show's section opens with a photo caption then a labelled heading, usually
 * flattened onto one line:
 *   "<Title> (c) <Photographer><Label>: <Title> <venue> <body...>"
 * Re-collecting the URL returns the whole post; extractShowSection keeps only
 * the section about `showTitle`, and returns null (never the whole post) when
 * the show can't be located. Separate from multi-show-splitter.js: that one
 * anchors on "Photo:"/"Credit:" captions and needs the full shows list.
 */

const { foldDiacritics } = require('./title-match');

const LABEL = '(?:Theat(?:er|re)|Off[- ]Off[- ]Broadway|Off[- ]Broadway|Broadway|Musical|Play|Opera|Dance|Cabaret|Concert|Film|Comedy)';
// photographer runs straight into the label with no space: "(c) Rachel Louise BrownTheater: "
const HEADING_RE = new RegExp(`\\(c\\)\\s(?:(?!\\(c\\))[^:\\n]){1,80}?(${LABEL}):\\s+`, 'g');

function norm(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\bblvd\b/g, 'boulevard'); // 'Sunset Blvd' heading for Sunset Boulevard
}

/** Normalized show name of a heading: the text before " at " (the venue). */
function headingShowName(title) {
  const a = norm(title);
  const i = a.indexOf(' at ');
  return i > 0 ? a.slice(0, i) : a;
}

/** Every "<Title> (c) ...Label: <Title>" heading: [{ start, title }] in text order. */
function findSectionHeadings(text) {
  const out = [];
  HEADING_RE.lastIndex = 0;
  let m;
  while ((m = HEADING_RE.exec(text)) !== null) {
    const headingEnd = m.index + m[0].length;
    const after = text.slice(headingEnd, headingEnd + 160);
    const beforeStart = Math.max(0, m.index - 120);
    const before = text.slice(beforeStart, m.index).trimEnd();
    // The caption title before "(c)" repeats right after the label: the longest
    // suffix of `before` that prefixes `after`, starting at a word boundary, is it.
    let start = m.index;
    const al = after.toLowerCase();
    for (let len = before.length; len >= 2; len--) {
      const prev = before.charAt(before.length - len - 1);
      if (prev && !/[\s.!?"”’)]/.test(prev)) continue;
      if (al.startsWith(before.slice(before.length - len).toLowerCase())) { start = beforeStart + before.length - len; break; }
    }
    out.push({ start, title: after });
  }
  return out;
}

/**
 * @param {string} text full blog post text
 * @param {string} showTitle
 * @param {string[]} [aliases] extra title variants
 * @returns {{ text: string, start: number, end: number, sectionCount: number } | null}
 */
/**
 * Normalized spellings a post may head a section with: the title, the shared
 * show-title variants ("Beaches, A New Musical" -> "beaches"), and the title
 * minus a leading first name before a possessive ("Stephen Sondheim's Old
 * Friends" -> "sondheims old friends").
 */
function sectionTitleVariants(showTitle, aliases = []) {
  const { buildShowTitleVariants } = require('./show-title-variants');
  const out = new Set([showTitle, ...aliases, ...buildShowTitleVariants(showTitle)].map(norm).filter(Boolean));
  for (const v of [...out]) {
    const m = v.match(/^\S+ (\S+s .+)$/);
    if (m && /['’]s\b/i.test(showTitle)) out.add(m[1]);
  }
  // Derived short forms must be >= 4 chars; the real title always counts ("Bug").
  const own = norm(showTitle);
  return [...out].filter(v => v === own || v.length >= 4);
}

function extractShowSection(text, showTitle, aliases = []) {
  if (!text || !showTitle) return null;
  const heads = findSectionHeadings(text);
  if (heads.length < 2) return null; // not a multi-show post of this shape
  const variants = sectionTitleVariants(showTitle, aliases);
  // "Thornton Wilder's The Emporium": also try the heading minus a possessive
  // author prefix — only a real one (apostrophe in the raw heading).
  const forms = (h) => {
    const out = [norm(h.title)];
    const m = String(h.title).match(/^(?:\S+\s){0,2}\S+['’]s\s/);
    if (m) out.push(norm(h.title.slice(m[0].length)));
    return out;
  };
  const matchWith = (test) => heads.map((h, i) => ({ h, i }))
    .filter(({ h }) => forms(h).some(a => variants.some(v => test(a, v))));
  // Exact first: most headings read "<Show> At <Venue> …", so the show name
  // is what precedes " at ". That keeps "Small" off a "Small Mouth Sounds"
  // section. Only with no exact hit fall back to a word-boundary prefix
  // ("Try/Step/Trip Under the Radar at A.R.T."), still requiring exactly one.
  let hits = matchWith((a, v) => headingShowName(a) === v || a === v);
  if (hits.length === 0) hits = matchWith((a, v) => a.startsWith(v + ' '));
  if (hits.length !== 1) return null; // absent or ambiguous: never guess
  const { h, i } = hits[0];
  const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
  return { text: text.slice(h.start, end).trim(), start: h.start, end, sectionCount: heads.length };
}

// Hosts that publish several shows' reviews in ONE post. Every text path
// (collector, manual ingest) must isolate the show's section before the text
// is stored or scored, or other shows' paragraphs get scored into the file.
// The corpus spells it www.interestedbystander.com; accept both forms.
const MULTI_SHOW_POST_HOSTS = [/(^|\.)(the)?interestedbystander\.com$/i];

function isMultiShowPostUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return MULTI_SHOW_POST_HOSTS.some((re) => re.test(host));
  } catch { return false; }
}

/**
 * The one gate every text path calls.
 * @returns {{ action: 'not-multi-show'|'single-section'|'isolated'|'refuse', text: string|null }}
 *   refuse = a multi-section post in which this show's section can't be found
 *   uniquely: store nothing rather than another show's text.
 */
function isolateMultiShowSection(url, text, showTitle, aliases = []) {
  if (!text || !isMultiShowPostUrl(url)) return { action: 'not-multi-show', text };
  if (findSectionHeadings(text).length < 2) return { action: 'single-section', text };
  const sec = extractShowSection(text, showTitle, aliases);
  if (!sec) return { action: 'refuse', text: null };
  return { action: 'isolated', text: sec.text };
}

let _titles = null;
function showTitleFor(showId) {
  if (!_titles) {
    _titles = new Map();
    try {
      const raw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
      for (const s of (raw.shows || raw)) if (s && s.id) _titles.set(s.id, s.title || '');
    } catch { /* shows.json unavailable: empty title => a multi-section post refuses (safe) */ }
  }
  return _titles.get(showId) || '';
}

/** Same gate, for writers that only know the showId (recovery scripts). */
function isolateMultiShowSectionForShowId(url, text, showId) {
  if (!isMultiShowPostUrl(url)) return { action: 'not-multi-show', text };
  return isolateMultiShowSection(url, text, showTitleFor(showId));
}

// Written to the file when a post has several sections and none is this
// show's, so collectors stop re-fetching it every run.
const MULTI_SHOW_NOT_FOUND_REASON = 'multi_show_section_not_found';

module.exports = {
  extractShowSection, findSectionHeadings, headingShowName, normSectionText: norm, isMultiShowPostUrl, isolateMultiShowSection,
  isolateMultiShowSectionForShowId, MULTI_SHOW_NOT_FOUND_REASON,
};
