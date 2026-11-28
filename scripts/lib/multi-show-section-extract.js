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
// BRO-6716: newer posts head sections "Theater Review: <Title>" as well as "Theater: <Title>".
const HEADING_RE = new RegExp(`\\(c\\)\\s(?:(?!\\(c\\))[^:\\n]){1,80}?\\s*(${LABEL})(?: Reviews?)?:\\s+`, 'g');

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
  // BRO-6716: a concert-series prefix our titles carry but posts drop
  // ("Encores! La Cage Aux Folles" is headed "La Cage aux Folles At Encores!").
  for (const v of [...out]) {
    const m = v.match(/^encores (.{4,})$/);
    if (m) out.add(m[1]);
  }
  const own = norm(showTitle);
  return [...out].filter(v => v === own || v.length >= 4);
}

function extractShowSection(text, showTitle, aliases = [], findHeadings = findSectionHeadings) {
  if (!text || !showTitle) return null;
  const heads = findHeadings(text);
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

/**
 * Nine Publishing "review wrap" pages (BRO-8433): The Age / SMH /
 * Brisbane Times / WAtoday print several short reviews on one
 * /culture/live-reviews/ page. Flattened, each item reads
 *   "<GENRE> <Title> ★★★½ <venue, run> <body> Reviewed by <Name> Advertisement"
 * A heading is a known genre word in capitals, the title, then 1-5 stars
 * within ~120 chars. The section runs to the next heading, so the item's
 * "Reviewed by" byline stays inside it. A single-review page has <2
 * headings and is left whole.
 */
// Longest first: "MUSICAL THEATRE" must win over "MUSICAL" and "THEATRE".
const NINE_GENRES = ['PHYSICAL THEATRE', 'MUSICAL THEATRE', 'MUSIC THEATRE', 'VISUAL ART', 'CLASSICAL MUSIC',
  'CONTEMPORARY MUSIC', 'MUSICAL', 'THEATRE', 'OPERA', 'MUSIC', 'JAZZ', 'DANCE', 'BALLET', 'COMEDY',
  'CABARET', 'CIRCUS', 'CLASSICAL', 'FESTIVAL', 'ART', 'FILM'];
const NINE_HEADING_RE = new RegExp(`(?:^|(?<=\\s))(${NINE_GENRES.join('|')})\\s+([^★\\n]{2,120}?)\\s*★{1,5}½?`, 'g');

/** Every "<GENRE> <Title> ★★★" item heading of a Nine review wrap: [{ start, title }]. */
function findNineWrapHeadings(text) {
  const out = [];
  NINE_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = NINE_HEADING_RE.exec(String(text || ''))) !== null) {
    let start = m.index;
    let title = m[2];
    // A capitalised genre word earlier in the previous item's body must not
    // swallow the real heading: re-anchor on the LAST genre inside the match.
    const inner = new RegExp(`(?:^|\\s)(${NINE_GENRES.join('|')})\\s+`, 'g');
    let im; let last = null;
    while ((im = inner.exec(title)) !== null) last = im;
    if (last) {
      const titleOffset = m[0].indexOf(m[2], m[1].length);
      start = m.index + titleOffset + last.index + (last[0].length - last[0].trimStart().length);
      title = title.slice(last.index + last[0].length);
    }
    title = title.trim();
    // A title made only of genre words ("THEATRE OPERA ★") is not one. All-caps
    // show titles (SIX, RENT, MJ) are.
    if (!title || new RegExp(`^(?:(?:${NINE_GENRES.join('|')})\\s*)+$`).test(title)) continue;
    // Real item headings open the page (after the "Share A A A" furniture) or
    // follow the previous item's "Advertisement" break. A caps genre word in a
    // body ("the ART Gallery rated ★★★★") is not a heading.
    if (out.length && !/(?:Advertisement|A A A)\s*$/.test(String(text).slice(Math.max(0, start - 40), start))) continue;
    out.push({ start, title });
  }
  return out;
}

/** "Reviewed by <Name>" of one isolated Nine wrap item, or null. */
function nineWrapSectionByline(sectionText) {
  // Name tokens: an initial ("J.") or a capitalised word with a lowercase
  // letter (so a following all-caps genre heading never joins the name), with
  // lowercase particles between them ("Anna de Souza"). Stops at ". Next".
  const tok = "[A-Z](?:\\.|[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*)";
  const particle = '(?:de|da|di|del|della|den|der|des|dos|du|la|le|van|von)';
  const re = new RegExp(`Reviewed by (${tok}(?: (?:${particle} )*(?!Advertisement\\b)${tok}){0,3})`, 'u');
  const m = String(sectionText || '').match(re);
  return m ? m[1].trim() : null;
}

// Hosts that publish several shows' reviews in ONE post, with the heading
// detector for each. Every text path (collector, manual ingest) must isolate
// the show's section before the text is stored or scored, or other shows'
// paragraphs get scored into the file. The corpus spells the bystander host
// www.interestedbystander.com; accept both forms.
const MULTI_SHOW_POST_STRATEGIES = [
  { name: 'interestedbystander', host: /(^|\.)(the)?interestedbystander\.com$/i, path: null, findHeadings: findSectionHeadings, sectionByline: null },
  { name: 'nine-review-wrap', host: /(^|\.)(theage|smh|brisbanetimes|watoday)\.com\.au$/i, path: /^\/culture\/live-reviews\//i, findHeadings: findNineWrapHeadings, sectionByline: nineWrapSectionByline },
];

function multiShowStrategyFor(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return MULTI_SHOW_POST_STRATEGIES.find((st) => st.host.test(host) && (!st.path || st.path.test(u.pathname))) || null;
  } catch { return null; }
}

function isMultiShowPostUrl(url) {
  return multiShowStrategyFor(url) !== null;
}

/**
 * Critic named inside an isolated section, for hosts that print one byline per
 * section (a Nine wrap credits each item; the page byline is the first item's
 * critic). null when the host has none or the section names nobody.
 */
function sectionCreditsCritic(url) {
  const st = multiShowStrategyFor(url);
  return !!(st && st.sectionByline);
}

function isolatedSectionByline(url, sectionText) {
  const st = multiShowStrategyFor(url);
  return st && st.sectionByline ? st.sectionByline(sectionText) : null;
}

/**
 * The critic to credit for a text a collector just ran through the section
 * gate. A host that credits each section (a Nine wrap) gives the section's own
 * byline, or null (Unknown) when the section names nobody, never the page
 * byline (that is the first item's critic). Anything else keeps fallbackCritic.
 * @param {string} url
 * @param {{action:string, text:string|null}} iso  result of isolateMultiShowSection*
 * @param {string|null} fallbackCritic
 * @returns {{ creditsSection: boolean, criticName: string|null }}
 */
function sectionCriticFor(url, iso, fallbackCritic) {
  if (iso && iso.action === 'isolated' && sectionCreditsCritic(url)) {
    return { creditsSection: true, criticName: isolatedSectionByline(url, iso.text) || null };
  }
  return { creditsSection: false, criticName: fallbackCritic == null ? null : fallbackCritic };
}

/**
 * Collector write step (collect-review-texts): credit an isolated Nine item to
 * its own section byline on `data`. A manual or locked credit stays. Returns
 * creditsSection so the caller skips every later page-author overwrite (the
 * page author is the first item's critic, a section byline never matches it).
 * @returns {{ creditsSection: boolean, changed: boolean, criticName: string|null }}
 */
function applySectionCritic(data, url, iso) {
  const sc = sectionCriticFor(url, iso, data.criticName || null);
  if (!sc.creditsSection) return { creditsSection: false, changed: false, criticName: null };
  if (data.criticNameManual || data._locked) return { creditsSection: true, changed: false, criticName: data.criticName || null };
  const next = sc.criticName || 'Unknown';
  const changed = data.criticName !== next;
  if (changed) { data._priorCriticName = data.criticName; data.criticName = next; data.criticEnrichedFrom = 'section-byline'; }
  return { creditsSection: true, changed, criticName: next };
}

/**
 * ingest-urls / ingest-review-from-url step: cut a multi-show post down to
 * this show's section before anything is written.
 * @param {{url:string, text:string|null, showTitle:string, criticName:string|null, ownerShowIds:()=>string[]}} a
 *   ownerShowIds: lazily lists the shows already holding this URL (url-ownership findCrossShowOwners).
 * @returns {{ refuse: true } | { refuse: false, isolated: boolean, text: string|null, criticName: string|null, writeFields: object }}
 */
function isolateForIngest({ url, text, showTitle, criticName, ownerShowIds }) {
  const iso = isolateMultiShowSection(url, text, showTitle);
  if (iso.action === 'refuse') return { refuse: true };
  if (iso.action !== 'isolated') return { refuse: false, isolated: false, text, criticName, writeFields: {} };
  return {
    refuse: false,
    isolated: true,
    text: iso.text,
    // A host that credits each section: no section byline means Unknown, never the
    // page byline (that is the first item's critic).
    criticName: sectionCriticFor(url, iso, criticName).criticName,
    writeFields: isolatedSectionWriteFields(iso, showTitle, ownerShowIds()),
  };
}

/** Section headings of a multi-show post, found with its host's detector ([] for other hosts). */
function findHeadingsForUrl(url, text) {
  const st = multiShowStrategyFor(url);
  return st ? st.findHeadings(String(text || '')) : [];
}

/**
 * The one gate every text path calls.
 * @returns {{ action: 'not-multi-show'|'single-section'|'isolated'|'refuse', text: string|null }}
 *   refuse = a multi-section post in which this show's section can't be found
 *   uniquely: store nothing rather than another show's text.
 */
function isolateMultiShowSection(url, text, showTitle, aliases = []) {
  // Critic columns (washingtonpost.com, BRO-6880) are NOT cut here: this gate
  // runs on every write, and title-based sectioning truncated single-show
  // reviews. They are isolated only after the verifier rejects the page as a
  // multi-show roundup (column-section-extract.js columnSectionAfterRoundupRejection).
  const st = text ? multiShowStrategyFor(url) : null;
  if (!st) return { action: 'not-multi-show', text };
  if (st.findHeadings(text).length < 2) return { action: 'single-section', text };
  const sec = extractShowSection(text, showTitle, aliases, st.findHeadings);
  if (!sec) return { action: 'refuse', text: null };
  return { action: 'isolated', text: sec.text };
}

/**
 * Extra review fields for a write whose text came from isolateMultiShowSection.
 * An isolated section is this show's own review, so the post's URL is shared
 * with the other shows' sections by design: the cross-show URL ownership gate
 * (url-ownership.js, honoured by review-file-writer and the push validator)
 * must not refuse it (BRO-4834: the Invention of Love section blocked the
 * America, Who Hurt You? section of the same post).
 * Stamped only when it is needed and safe: some other show holds the URL, and
 * every holder has a different title. A same-title sibling (tender vs
 * tender-by-dave-harris) isolates the very same section, so Guard I must
 * still decide that one.
 * @param {{action:string}} iso isolateMultiShowSection() result
 * @param {string} showTitle this show's title
 * @param {string[]} ownerShowIds shows that already hold the URL live
 */
function isolatedSectionWriteFields(iso, showTitle, ownerShowIds) {
  if (!iso || iso.action !== 'isolated' || !ownerShowIds || ownerShowIds.length === 0) return {};
  const mine = norm(showTitle);
  const distinct = ownerShowIds.every((id) => {
    const t = norm(showTitleFor(id));
    return t && mine && t !== mine;
  });
  return distinct ? { allowCrossShowUrl: true } : {};
}

/** Every show title in shows.json (the titles a critic column's sections may open with). */
function allShowTitles() {
  showTitleFor('');
  return [...new Set(_titles.values())].filter(Boolean);
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

/** Test seam: seed showId -> title so tests need no data/shows.json (untracked core data). */
function seedShowTitlesForTest(obj) { _titles = new Map(Object.entries(obj || {})); }

/** Same gate, for writers that only know the showId (recovery scripts). */
function isolateMultiShowSectionForShowId(url, text, showId) {
  if (!isMultiShowPostUrl(url)) return { action: 'not-multi-show', text };
  return isolateMultiShowSection(url, text, showTitleFor(showId));
}

// Written to the file when a post has several sections and none is this
// show's, so collectors stop re-fetching it every run.
const MULTI_SHOW_NOT_FOUND_REASON = 'multi_show_section_not_found';

module.exports = {
  extractShowSection, findSectionHeadings, findNineWrapHeadings, nineWrapSectionByline, findHeadingsForUrl,
  multiShowStrategyFor, MULTI_SHOW_POST_STRATEGIES, isolatedSectionByline, sectionCriticFor, applySectionCritic, isolateForIngest, headingShowName, normSectionText: norm, sectionTitleVariants, isMultiShowPostUrl, isolateMultiShowSection,
  isolateMultiShowSectionForShowId, seedShowTitlesForTest, isolatedSectionWriteFields, MULTI_SHOW_NOT_FOUND_REASON, allShowTitles,
};
