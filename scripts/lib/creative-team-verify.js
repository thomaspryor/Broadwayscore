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

// Canonical role label written into show.creativeTeam. src/lib/data-creative.ts
// ROLE_TO_CATEGORIES is exact-case — writing "playwright" or "Book writer"
// (lowercase from LLM) silently drops the entry from /playwrights pages.
const ROLE_CANON = {
  director: 'Director', playwright: 'Playwright', choreographer: 'Choreographer',
  'book writer': 'Book Writer', book: 'Book',
  composer: 'Composer', lyricist: 'Lyricist',
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
         r === 'composer' ? 'music by' :
         r === 'lyricist' ? 'lyrics by' : null;
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
    book: ['book by', 'written by', 'book and'],
    composer: ['music by', 'composed by', 'score by', 'music and'],
    lyricist: ['lyrics by', 'lyrics and'],
    music: ['music by', 'composed by', 'score by', 'music and'],
    lyrics: ['lyrics by', 'lyrics and'],
    'music & lyrics': ['music and lyrics by', 'music & lyrics by', 'songs by', 'written by', 'music by'],
    'book, music & lyrics': ['written by', 'book, music', 'music and lyrics by', 'music by'],
  };
  return map[r] || null;
}

/**
 * Distinctive lowercase tokens for tying a snippet segment to THIS show.
 * Full title plus the pre-colon short title for subtitled shows.
 */
function titleTokens(title) {
  const t = String(title || '').toLowerCase().trim();
  const tokens = t ? [t] : [];
  if (t.includes(':')) tokens.push(t.split(':')[0].trim());
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
  const nameLC = String(name).toLowerCase();
  const wanted = phrases.map(p => `${p.toLowerCase()} ${nameLC}`);
  const anchors = titleTokens(opts.title);

  return serpResults.some(r => {
    const pageTitle = (r.title || '').toLowerCase();
    const snippet = (r.snippet || '').toLowerCase();
    if (anchors.length === 0) {
      // No title anchor supplied — legacy loose check.
      return wanted.some(w => (pageTitle + ' ' + snippet).includes(w));
    }
    const pageTitleNamesShow = anchors.some(a => pageTitle.includes(a));
    // Google joins unrelated page fragments with "..." / "…" — treat each
    // fragment as its own evidence unit.
    const segments = snippet.split(/\.\.\.|…/);
    return segments.some(seg =>
      wanted.some(w => seg.includes(w)) &&
      (pageTitleNamesShow || anchors.some(a => seg.includes(a)))
    );
  });
}

module.exports = { ROLE_CANON, roleVerb, roleVerbVariants, serpTextConfirms, titleTokens };
