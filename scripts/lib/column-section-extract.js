/**
 * BRO-6880: section isolation for multi-show CRITIC COLUMNS from T1/T2 outlets
 * (Washington Post: "Stars are shining on Broadway ... " covers Other Desert
 * Cities, School Girls and The Imaginary Invalid in one piece).
 *
 * multi-show-section-extract.js handles the interestedbystander blog shape
 * ("(c) photographer Label: Title" headings). A column has no such markup: each
 * show's part opens with a paragraph that names the show near its start. So the
 * sections are found from titles: a paragraph that names exactly one known show
 * in its opening chars starts that show's section, later paragraphs inherit it,
 * and a paragraph naming two or more shows (a comparison or wrap-up) belongs to
 * nobody. Pure functions; callers pass the known show titles.
 *
 * A true roundup (the page quotes OTHER critics' verdicts) is never isolated:
 * action 'refuse' stores nothing, as for any multi-show post we cannot split.
 */

const { sectionTitleVariants, normSectionText: norm } = require('./multi-show-section-extract');

// Outlets whose multi-show critic columns we isolate. Add a host only for a
// critic's own column; the roundup guard below still applies to it.
const COLUMN_POST_HOSTS = [/(^|\.)washingtonpost\.com$/i];

const OPENER_CHARS = 160;      // a section opener names its show this early
const MIN_SECTION_WORDS = 60;  // each section of a real column is a review, not an aside
const MIN_TARGET_WORDS = 60;
const MIN_TITLE_MENTIONS = 2;  // a passing "like Hamilton" opener is not a section; a reviewed show is named again
const ROUNDUP_ATTRIBUTIONS = 2;

function isColumnPostUrl(url) {
  try {
    return COLUMN_POST_HOSTS.some((re) => re.test(new URL(url).hostname.replace(/^www\./, '')));
  } catch { return false; }
}

const OTHER_CRITIC_OUTLETS = '(?:The\\s+)?(?:New York Times|Times|Variety|Hollywood Reporter|Vulture|New Yorker|Guardian|Time Out|TheaterMania|Daily Beast|Deadline|Wall Street Journal|WSJ|New York Post|Post|Associated Press|AP|Observer|Playbill|Broadway News|Financial Times|Telegraph|Independent|Evening Standard|NY Stage Review|Theatrely)';
const NAME = "(?:[A-Z][\\w.'’-]+\\s+){1,3}";
const ATTRIBUTION_RES = [
  new RegExp(`\\b(?:according to|per)\\s+${OTHER_CRITIC_OUTLETS}\\b`, 'gi'),
  new RegExp(`\\b${OTHER_CRITIC_OUTLETS}\\s+(?:critic\\s+${NAME})?(?:called|calls|wrote|writes|said|says|raved|praised|panned|declared|described|found|dubbed)\\b`, 'g'),
  new RegExp(`\\b(?:wrote|writes|said|says|raved|declared|noted)\\s+${NAME}(?:of|in|for|at)\\s+${OTHER_CRITIC_OUTLETS}\\b`, 'g'),
  new RegExp(`\\b${NAME}(?:of|in|for|at)\\s+${OTHER_CRITIC_OUTLETS},?\\s+(?:called|wrote|writes|said|raved|praised|panned|declared|described)\\b`, 'g'),
];

/** How many places the text hands the verdict to another critic or outlet. */
function countOtherCriticAttributions(text) {
  const t = String(text || '');
  let n = 0;
  for (const re of ATTRIBUTION_RES) { re.lastIndex = 0; n += (t.match(re) || []).length; }
  return n;
}

const wordCount = (s) => (String(s).match(/\S+/g) || []).length;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mentionRe(variant) { return new RegExp(`(^| )${escapeRe(variant)}(?= |$)`, 'g'); }

/**
 * Mark every known title in a normalized string. Longest variants first, each
 * match blanked so "Hamilton" inside "Hamilton Hits" is not counted twice.
 * @returns {Array<{key:string,pos:number}>}
 */
function findMentions(normText, titleDefs) {
  const found = [];
  let work = normText;
  for (const def of titleDefs) {
    for (const v of def.variants) {
      const re = mentionRe(v);
      let m;
      while ((m = re.exec(work)) !== null) {
        const pos = m.index + m[1].length;
        found.push({ key: def.key, pos });
        work = work.slice(0, pos) + '#'.repeat(v.length) + work.slice(pos + v.length);
        re.lastIndex = pos + v.length;
      }
    }
  }
  return found;
}

/**
 * @param {string} text column text, paragraphs separated by newlines
 * @param {string} showTitle target show
 * @param {{aliases?:string[], knownTitles?:string[]}} [opts] knownTitles: every show title that may head a section
 * @returns {{ action: 'single-section'|'isolated'|'refuse', text: string|null, reason?: string, sectionCount?: number }}
 */
function isolateColumnSection(text, showTitle, { aliases = [], knownTitles = [] } = {}) {
  const unchanged = { action: 'single-section', text };
  if (!text || !showTitle) return unchanged;
  const segments = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 4) {
    const flat = isolateFlatColumnSection(text, showTitle, { aliases, knownTitles });
    return flat || unchanged;
  }

  const targetKey = norm(showTitle);
  const targetVariants = sectionTitleVariants(showTitle, aliases);
  const defs = [{ key: targetKey, variants: targetVariants, target: true }];
  const seen = new Set([targetKey]);
  const fullNorm = norm(text);
  for (const t of knownTitles) {
    const key = norm(t);
    if (!key || key.length < 6 || seen.has(key) || targetVariants.includes(key)) continue;
    seen.add(key);
    if (!mentionRe(key).test(fullNorm)) continue; // not named anywhere in this column
    const variants = sectionTitleVariants(t).filter((v) => !targetVariants.includes(v));
    if (variants.length) defs.push({ key, variants });
  }
  for (const d of defs) d.variants.sort((a, b) => b.length - a.length);
  defs.sort((a, b) => Math.max(...b.variants.map((v) => v.length)) - Math.max(...a.variants.map((v) => v.length)));
  if (defs.length < 2) return unchanged;

  // Per-paragraph owner. null before any opener; 'mixed' paragraphs name 2+ shows.
  let owner = null;
  const mentionCount = new Map();
  const rows = segments.map((seg) => {
    const mentions = findMentions(norm(seg), defs);
    const keys = new Set(mentions.map((m) => m.key));
    for (const m of mentions) mentionCount.set(m.key, (mentionCount.get(m.key) || 0) + 1);
    const row = { seg, mixed: keys.size >= 2, owner: null, opener: null };
    if (keys.size === 1) {
      const first = mentions.reduce((a, b) => (b.pos < a.pos ? b : a));
      if (first.pos <= OPENER_CHARS && first.key !== owner) { owner = first.key; row.opener = first.key; }
    }
    row.owner = owner;
    return row;
  });

  // Each owner's own words, excluding mixed paragraphs; and how often it is named.
  const words = new Map(); const openers = new Map();
  for (const r of rows) {
    if (r.opener) openers.set(r.opener, (openers.get(r.opener) || 0) + 1);
    if (r.owner && !r.mixed) words.set(r.owner, (words.get(r.owner) || 0) + wordCount(r.seg));
  }
  const sectionKeys = [...openers.keys()].filter((k) => (words.get(k) || 0) >= MIN_SECTION_WORDS && (mentionCount.get(k) || 0) >= MIN_TITLE_MENTIONS);
  // Not a column of >= 2 real review sections: leave the page to the verifier.
  if (sectionKeys.length < 2) return unchanged;

  // From here the page is a multi-show column: isolate or refuse, never pass it whole.
  if (countOtherCriticAttributions(text) >= ROUNDUP_ATTRIBUTIONS) {
    return { action: 'refuse', text: null, reason: 'roundup', sectionCount: sectionKeys.length };
  }
  if (!sectionKeys.includes(targetKey)) return { action: 'refuse', text: null, reason: 'show-not-found', sectionCount: sectionKeys.length };
  if ((openers.get(targetKey) || 0) !== 1) return { action: 'refuse', text: null, reason: 'ambiguous', sectionCount: sectionKeys.length };

  const mine = rows.filter((r) => r.owner === targetKey && !r.mixed).map((r) => r.seg);
  const out = mine.join('\n\n');
  if (wordCount(out) < MIN_TARGET_WORDS) return { action: 'refuse', text: null, reason: 'too-short', sectionCount: sectionKeys.length };
  if (countOtherCriticAttributions(out) >= 1) return { action: 'refuse', text: null, reason: 'roundup', sectionCount: sectionKeys.length };
  return { action: 'isolated', text: out, sectionCount: sectionKeys.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Flattened columns (BRO-6872). Some fetch routes return the column as one line (the 10-23 column covering The
// Imaginary Invalid arrived as 9,120 characters with no newline), so the paragraph openers above cannot be seen.
// Each review in these columns ends with its listing footer ("About 1 hour 30 minutes. roundabouttheatre.org."), so
// the footers mark the sections. A section belongs to the show it names first; a show must own exactly one section.
// Titles count only capitalized and two words or longer after a leading article ("The Doctor" is everyday prose), the
// same rule the lane's column hold uses. Sentences that name another show are dropped from the section kept.

const FLAT_MIN_CHARS = 1500;
const FLAT_OWNER_CHARS = 400; // a section names its show this early
const SECTION_FOOTER = /About\s+\d+\s+(?:hours?|minutes?)(?:\s+\d+\s+minutes?)?(?:,\s*(?:including|with)\s+(?:an?\s+|one\s+|two\s+)?intermissions?)?\.\s+[\w.-]+\.(?:com|org|net|nyc|co\.uk)\/?\S*\.?/g;

/** Sentences: split after . ! ? (and a closing quote) before a capital or an opening quote. */
function splitSentences(text) {
  return String(text).split(/(?<=[.!?\u2026]["\u201d\u2019')\]]?)\s+(?=["\u201c\u2018(]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}

const foldText = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
/** Title words for matching: no parenthetical, no leading article, letters and digits only. */
function flatTitleWords(title) {
  const words = foldText(String(title || '').replace(/\([^)]*\)/g, ' ')).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length && /^(the|a|an)$/i.test(words[0])) words.shift();
  return words.length >= 2 ? words : null;
}

/** First character offsets of each title in `text` (case-insensitive words, capitalized first letter), longest first. */
function flatMentions(text, defs) {
  const words = []; const re = /[A-Za-z0-9]+/g; let m;
  const folded = foldText(text);
  while ((m = re.exec(folded)) !== null) words.push({ w: m[0], lw: m[0].toLowerCase(), pos: m.index });
  const taken = new Array(words.length).fill(false);
  const found = [];
  const all = [];
  for (const d of defs) for (const v of d.variants) all.push({ key: d.key, v: v.map((x) => x.toLowerCase()) });
  all.sort((a, b) => b.v.length - a.v.length);
  for (const { key, v } of all) {
    for (let i = 0; i + v.length <= words.length; i++) {
      if (taken[i] || !/^[A-Z0-9]/.test(words[i].w)) continue;
      let ok = true;
      for (let j = 0; j < v.length; j++) if (taken[i + j] || words[i + j].lw !== v[j]) { ok = false; break; }
      if (!ok) continue;
      for (let j = 0; j < v.length; j++) taken[i + j] = true;
      found.push({ key, pos: words[i].pos });
    }
  }
  return found;
}

/**
 * @returns {null | { action: 'isolated'|'refuse', text: string|null, reason?: string, sectionCount: number }}
 *   null: not a flattened multi-review column (the caller treats the page as one review).
 */
function isolateFlatColumnSection(text, showTitle, { aliases = [], knownTitles = [] } = {}) {
  const str = String(text || '');
  if (str.length < FLAT_MIN_CHARS || /\n/.test(str.trim())) return null;
  const ends = []; let m; SECTION_FOOTER.lastIndex = 0;
  while ((m = SECTION_FOOTER.exec(str)) !== null) ends.push(m.index + m[0].length);
  if (ends.length < 2) return null;
  const sections = []; let start = 0;
  for (const e of ends) { sections.push(str.slice(start, e).trim()); start = e; }
  const tail = str.slice(start).trim();
  if (tail) sections[sections.length - 1] += ` ${tail}`; // closing credits after the last footer stay with it

  const targetKey = norm(showTitle);
  const targetVariants = [showTitle, ...aliases].map(flatTitleWords).filter(Boolean);
  if (!targetVariants.length) return { action: 'refuse', text: null, reason: 'show-not-found', sectionCount: sections.length };
  const defs = [{ key: targetKey, variants: targetVariants }];
  const seen = new Set([targetKey]);
  const targetSig = new Set(targetVariants.map((v) => v.join(' ').toLowerCase()));
  for (const t of knownTitles) {
    const key = norm(t); const w = flatTitleWords(t);
    if (!key || !w || seen.has(key) || targetSig.has(w.join(' ').toLowerCase())) continue;
    seen.add(key);
    defs.push({ key, variants: [w] });
  }

  const owners = sections.map((sec) => {
    const first = flatMentions(sec, defs).filter((x) => x.pos <= FLAT_OWNER_CHARS).sort((a, b) => a.pos - b.pos)[0];
    return first ? first.key : null;
  });
  const mine = owners.map((o, i) => (o === targetKey ? i : -1)).filter((i) => i >= 0);
  if (mine.length === 0) return { action: 'refuse', text: null, reason: 'show-not-found', sectionCount: sections.length };
  if (mine.length > 1) return { action: 'refuse', text: null, reason: 'ambiguous', sectionCount: sections.length };
  const kept = splitSentences(sections[mine[0]]).filter((s) => !flatMentions(s, defs).some((x) => x.key !== targetKey));
  const out = kept.join(' ');
  if (wordCount(out) < MIN_TARGET_WORDS) return { action: 'refuse', text: null, reason: 'too-short', sectionCount: sections.length };
  if (countOtherCriticAttributions(out) >= 1) return { action: 'refuse', text: null, reason: 'roundup', sectionCount: sections.length };
  return { action: 'isolated', text: out, sectionCount: sections.length };
}

module.exports = { COLUMN_POST_HOSTS, isColumnPostUrl, isolateColumnSection, countOtherCriticAttributions, isolateFlatColumnSection, splitSentences };
