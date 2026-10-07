/**
 * Creative-team SERP verification — shared decision logic.
 *
 * Extracted from auto-fix-show-data.js (write-path guard, added 2026-05-26
 * after the LLM hallucinated "Martyna Majok (Book Writer)" for Liberation).
 * The same failure mode shipped pre-guard entries that are still in the
 * corpus (Giulia PAC NYC carried Stefano Massini/Ludovico Einaudi — an
 * invented Italian team — from creation ~Feb 2026 until 2026-07-09).
 * audit-creative-team-serp.js uses these helpers to retro-verify them.
 *
 * Pure functions only — no network. Callers run serpQuery and pass results in.
 */

const { foldDiacritics } = require('./title-match');

// Canonical role label written into show.creativeTeam. src/lib/data-creative.ts
// ROLE_TO_CATEGORIES is exact-case — writing "playwright" or "Book writer"
// (lowercase from LLM) silently drops the entry from /playwrights pages.
const ROLE_CANON = {
  director: 'Director', playwright: 'Playwright', choreographer: 'Choreographer',
  'book writer': 'Book Writer', book: 'Book',
  composer: 'Composer', lyricist: 'Lyricist',
  // IBDB's extractCreativeTeamFromText() (lib/ibdb-dates.js) emits these
  // exact labels — added for BRO-102 so the IBDB scrape path can route
  // through the same SERP-verification gate as the LLM path.
  music: 'Music', lyrics: 'Lyrics', 'music & lyrics': 'Music & Lyrics',
};

/**
 * Primary attribution verb for a role — the exact phrase the write path
 * requires in a SERP snippet ("directed by <name>"). Returns null for roles
 * that have no verifiable attribution phrase (design roles etc.).
 */
function roleVerb(role) {
  const r = String(role || '').toLowerCase();
  return r === 'director' ? 'directed by' :
         r === 'playwright' ? 'written by' :
         r === 'choreographer' ? 'choreographed by' :
         (r === 'book writer' || r === 'book') ? 'book by' :
         (r === 'composer' || r === 'music') ? 'music by' :
         (r === 'lyricist' || r === 'lyrics') ? 'lyrics by' :
         r === 'music & lyrics' ? 'music and lyrics by' : null;
}

/**
 * Verb variants for retro-audit. Wider than roleVerb because published
 * coverage phrases credits inconsistently ("music by" vs "composed by").
 * The write path stays strict (single verb); the audit only needs ONE
 * variant to hit to clear a member, so variants reduce false rejections
 * without weakening the hallucination signal (hallucinated names fail the
 * co-occurrence check regardless of verbs).
 */
function roleVerbVariants(role) {
  const r = String(role || '').toLowerCase();
  const map = {
    director: ['directed by', 'direction by', 'director'],
    playwright: ['written by', 'play by', 'written and'],
    choreographer: ['choreographed by', 'choreography by'],
    'book writer': ['book by', 'written by', 'book and'],
    'book writers': ['book by', 'written by', 'book and'],
    book: ['book by', 'written by', 'book and'],
    composer: ['music by', 'composed by', 'score by', 'music and'],
    lyricist: ['lyrics by', 'lyrics and'],
    music: ['music by', 'composed by', 'score by', 'music and'],
    lyrics: ['lyrics by', 'lyrics and'],
    'music & lyrics': ['music and lyrics by', 'music & lyrics by', 'songs by', 'written by', 'music by'],
    'book, music & lyrics': ['written by', 'book, music', 'music and lyrics by', 'music by'],
    'book/music/lyrics': ['written by', 'book, music', 'music and lyrics by', 'music by', 'book by'],
    'composer and lyricist': ['music and lyrics by', 'music by', 'lyrics by', 'composed by', 'songs by'],
    'co-author': ['written by', 'co-written by', 'co-authored by', 'by'],
    creator: ['created by', 'creator', 'written by'],
    'creator, performer': ['created by', 'created and performed by', 'written by'],
    'writer, performer': ['written by', 'written and performed by', 'created by'],
    writer: ['written by', 'by'],
    author: ['written by', 'by'],
  };
  return map[r] || null;
}

/**
 * Normalize typographic variance before substring matching: curly quotes →
 * straight, en/em dashes → hyphen, collapsed whitespace. Snippets and our
 * titles disagree on these constantly ("I'm Sorry, Prime Minister" with a
 * curly apostrophe never matches a straight-quoted snippet otherwise).
 * See memory/feedback_word_boundary_punct_titles.md for the general rule.
 */
function normalizeForMatch(s) {
  // foldDiacritics: SERP snippets spell names and titles with their real
  // accents ("Édouard Louis", "Thérèse Raquin") while shows.json is mixed, so
  // an unfolded compare drops the confirmation entirely. Task #648.
  return foldDiacritics(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Distinctive lowercase tokens for tying a snippet segment to THIS show.
 * Full normalized title plus a pre-subtitle short token (split on colon or
 * a spaced dash) for subtitled shows.
 */
function titleTokens(title) {
  const t = normalizeForMatch(title);
  const tokens = t ? [t] : [];
  const cut = t.split(/:|\s-\s/)[0].trim();
  if (cut && cut !== t && cut.length >= 4) tokens.push(cut);
  return tokens;
}

/**
 * Pure phrase check: does any SERP result confirm "<phrase> <name>" as an
 * attribution for THIS show?
 *
 * Two hardenings over a naive substring check:
 * 1. Full attribution phrase required ("directed by mary zimmerman"), never
 *    just the name — prevents unrelated-context hits.
 * 2. The phrase must appear in the same snippet SEGMENT as a title token, or
 *    the result's page title must name the show. Google stitches disjoint
 *    page fragments into one snippet joined by ellipses — a 1991 NYT dance
 *    review crediting "music by Ludovico Einaudi" plus a sitewide events
 *    module mentioning "Giulia: The Poison Queen of Palermo" on the same
 *    page read as a confirmation without this (caught 2026-07-09 while
 *    building the retro-audit; this exact stitch had let the hallucinated
 *    Giulia team look verifiable).
 *
 * opts.title: the show title (required for segment anchoring; without it,
 * falls back to the phrase-only check for backward compatibility).
 */
function serpTextConfirms(serpResults, phrases, name, opts = {}) {
  if (!Array.isArray(serpResults) || serpResults.length === 0) return false;
  const nameN = normalizeForMatch(name);
  const wanted = phrases.map(p => `${normalizeForMatch(p)} ${nameN}`);
  const anchors = titleTokens(opts.title);

  return serpResults.some(r => {
    const pageTitle = normalizeForMatch(r.title);
    const snippet = normalizeForMatch(r.snippet);
    if (anchors.length === 0) {
      // No title anchor supplied — legacy loose check.
      return wanted.some(w => (pageTitle + ' ' + snippet).includes(w));
    }
    const pageTitleNamesShow = anchors.some(a => pageTitle.includes(a));
    // Google joins unrelated page fragments with "..." or "…" — treat each
    // fragment as its own evidence unit.
    const segments = snippet.split(/\.\.\.|…/);
    return segments.some(seg =>
      wanted.some(w => seg.includes(w)) &&
      (pageTitleNamesShow || anchors.some(a => seg.includes(a)))
    );
  });
}

module.exports = { ROLE_CANON, roleVerb, roleVerbVariants, serpTextConfirms, titleTokens, normalizeForMatch };
