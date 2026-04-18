/**
 * Score Input Validator
 *
 * Pre-validates text before LLM scoring to catch nav-chrome scraping failures.
 * Prevents the TheaterMania opening-night incident (Proof 2026-04-16) where
 * the LLM scored nav chrome as 95/Rave with reasoning "no actual review
 * content... assuming hypothetical positive review."
 *
 * Per CLAUDE.md §15: pure functions only, exported for testing, never copied inline.
 */

// Patterns that identify individual lines as navigation chrome rather than content.
// The primary target is breadcrumbs: "BroadwayMania > Shows > Proof > Reviews".
const JUNK_LINE_RE = [
  /^\s*(home|menu|navigation|subscribe|login|sign\s+in|register|account|contact|about)\s*$/i,
  /^\s*advertisement\s*$/i,
  /^\s*(share|tweet|email|print|save|bookmark)\s*(this)?\s*$/i,
  /^\s*(tags?|categories?|topics?):\s*\S/i,
  /^\s*related\s+(stories|articles|news|reviews)\s*$/i,
  /^\s*\d+\s*comments?\s*$/i,
  /^\s*\d+\s*shares?\s*$/i,
  /^\s*follow\s+us\b/i,
  /^\s*(more\s+in|also\s+on)\s+\w/i,
];

/**
 * Returns true if a line is chrome/nav rather than review content.
 */
function isJunkLine(line) {
  const t = line.trim();
  if (!t) return false;
  // Very short lines: punctuation, single letters, icon labels
  if (t.length <= 3) return true;
  // Breadcrumb heuristic: words separated by > | » ›, line under 120 chars
  if (/\w\s*[>»›|]\s*\w/.test(t) && t.length < 120) return true;
  for (const re of JUNK_LINE_RE) {
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * Ratio of junk lines to all non-empty lines (0–1).
 */
function navChromeRatio(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return 0;
  const junk = lines.filter(isJunkLine).length;
  return junk / lines.length;
}

/**
 * Remove junk lines, return the remaining body.
 */
function stripNavChrome(text) {
  return text.split('\n').filter(l => !isJunkLine(l)).join('\n').trim();
}

/**
 * Count total occurrences of show-identifying keywords in body.
 * Accepts either a string title or a show object `{ title, cast, creativeTeam, venue }`.
 *
 * Counts total *occurrences* (not distinct keyword types) so a title like "Proof"
 * appearing 5 times in a review body passes the ≥2 threshold without needing
 * separate cast/venue keywords in the input.
 *
 * Returns as soon as 2 occurrences are found (early exit for speed).
 */
function countShowKeywords(body, show) {
  if (!show) return 99; // no show provided → skip keyword gate
  const lower = body.toLowerCase();
  const keywords = new Set();

  function addWords(str, minLen) {
    if (!str) return;
    const clean = str.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    for (const w of clean.split(/\s+/)) {
      if (w.length >= minLen) keywords.add(w);
    }
  }

  if (typeof show === 'string') {
    const fullTitle = show.toLowerCase().trim();
    if (fullTitle.length >= 2) keywords.add(fullTitle); // always add full title (handles "Six", "Bug", "Wit")
    addWords(show, 4);
  } else {
    if (show.title) {
      const fullTitle = show.title.toLowerCase().trim();
      if (fullTitle.length >= 2) keywords.add(fullTitle); // always add full title
      addWords(show.title, 4);
    }
    for (const c of (show.cast || []).slice(0, 5)) {
      if (!c || !c.name) continue;
      const last = c.name.split(/\s+/).pop().toLowerCase();
      if (last.length >= 4) keywords.add(last);
    }
    for (const c of (show.creativeTeam || []).slice(0, 3)) {
      if (!c || !c.name) continue;
      const last = c.name.split(/\s+/).pop().toLowerCase();
      if (last.length >= 4) keywords.add(last);
    }
    if (show.venue) addWords(show.venue, 5);
  }

  // Count total keyword occurrences across all keywords (not just distinct keyword types).
  // A single keyword like "Proof" appearing 5 times → 5 occurrences → passes ≥2 threshold.
  let totalOccurrences = 0;
  for (const kw of keywords) {
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(kw, pos);
      if (idx === -1) break;
      totalOccurrences++;
      pos = idx + kw.length;
      if (totalOccurrences >= 2) return totalOccurrences;
    }
  }
  return totalOccurrences;
}

/**
 * Validate that `text` is scoreable review content before sending to the LLM.
 *
 * Gates (in order):
 *   1. nav_chrome_majority: junk-line ratio of raw text ≥ 0.5
 *   2. body_too_short: stripped body < 1000 chars (unless isExcerpt)
 *   3. insufficient_show_keywords: < 2 show keywords found in body
 *
 * @param {string} text - Text to validate (fullText or combined excerpt)
 * @param {string|Object|null} show - Show title string or show object for keyword check
 * @param {{ isExcerpt?: boolean }} options
 *   isExcerpt: if true, skip the body-length gate (aggregator excerpts are short by design)
 * @returns {{ ok: boolean, reason: string, body: string }}
 */
function validateScoreableText(text, show, options) {
  const isExcerpt = options && options.isExcerpt;

  if (!text || typeof text !== 'string') {
    return { ok: false, reason: 'no_text', body: '' };
  }

  // Gate 1: nav chrome ratio on the raw text
  const ratio = navChromeRatio(text);
  // Strip nav chrome before any return so body is always the stripped version
  const body = stripNavChrome(text);
  if (ratio >= 0.5) {
    return { ok: false, reason: 'nav_chrome_majority', body };
  }

  // Gate 2: body must have enough content (unless caller says it is an excerpt)
  if (!isExcerpt && body.length < 1000) {
    return { ok: false, reason: 'body_too_short', body };
  }

  // Gate 3: show keyword density (≥ 2 keywords must appear)
  const kwCount = countShowKeywords(body || text, show);
  if (kwCount < 2) {
    return { ok: false, reason: 'insufficient_show_keywords', body };
  }

  return { ok: true, reason: 'ok', body };
}

/**
 * Post-LLM validator: detect when the model scored a hypothetical/hallucinated review.
 *
 * The Proof 2026-04-16 incident: LLM reasoning said "no actual review content...
 * assuming hypothetical positive review, assigning rave score." This function
 * catches that confession pattern so callers can refuse to write the score.
 *
 * @param {string} reasoning - LLM reasoning text (from any model)
 * @returns {{ refused: boolean, reason: string }}
 */
function detectHallucinatedScore(reasoning) {
  if (!reasoning || typeof reasoning !== 'string') {
    return { refused: false, reason: '' };
  }
  const HALLUCINATION_RE = /no\s+(?:actual\s+)?(?:review\s+content|actual\s+review)|cannot\s+(?:accurately\s+)?score|hypothetical\s+(?:positive\s+|negative\s+|rave\s+|mixed\s+|pan\s+)?(?:review|rating)|assuming\s+(?:hypothetical|positive|rave|mixed|negative|pan)\s+(?:review|rating|score)/i;
  if (HALLUCINATION_RE.test(reasoning)) {
    return { refused: true, reason: 'hallucinated_score' };
  }
  return { refused: false, reason: '' };
}

module.exports = { validateScoreableText, detectHallucinatedScore };
