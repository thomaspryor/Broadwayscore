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
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
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
function extractShowSection(text, showTitle, aliases = []) {
  if (!text || !showTitle) return null;
  const heads = findSectionHeadings(text);
  if (heads.length < 2) return null; // not a multi-show post of this shape
  const variants = [showTitle, ...aliases].map(norm).filter(Boolean);
  const hits = heads.map((h, i) => ({ h, i })).filter(({ h }) => {
    const a = norm(h.title);
    return variants.some(v => a === v || a.startsWith(v + ' '));
  });
  if (hits.length !== 1) return null; // absent or ambiguous: never guess
  const { h, i } = hits[0];
  const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
  return { text: text.slice(h.start, end).trim(), start: h.start, end, sectionCount: heads.length };
}

module.exports = { extractShowSection, findSectionHeadings };
