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
const { serpQuery } = require('./url-discovery');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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

/**
 * Shared SERP-verification gate for creative-team writes — network call.
 *
 * 2026-05-26: previously non-director roles proposed by the LLM were accepted
 * without verification. Result: LLM hallucinated "Martyna Majok (Book Writer)"
 * for Liberation (correct: Bess Wohl, Playwright) and reached production. Now
 * ALL roles require SERP confirmation; unrecognized roles (design/tech
 * credits with no reliable "<verb> <name>" attribution phrase — Scenic
 * Design, Orchestrations, etc.) are rejected rather than trusted verbatim.
 *
 * BRO-102 (2026-08-20): the auto-fix-show-data.js IBDB scrape path previously
 * took ibdb.creativeTeam verbatim — a wrong table cell or stale IBDB entry
 * would repeat the wrong-attribution pattern for any Broadway show with an
 * ibdbUrl. It now routes through this same gate before writing. Extracted
 * here (BRO-102 follow-up, task #1863) so every other ibdb.creativeTeam
 * writer (discover-new-shows.js, enrich-ibdb-dates.js,
 * backfill-playwright-credits.js) can import it without pulling in
 * auto-fix-show-data.js's other dependencies.
 *
 * Cost: up to ~7 SERP calls (one per verifiable role) per call. Callers that
 * run over large batches (e.g. enrich-ibdb-dates.js's weekly cron) should
 * watch SB SERP credit headroom — see memory/feedback_sb_serp_invisible_burn.md.
 *
 * Scope note: this SERP check confirms "<verb> <name>" for the show's TITLE,
 * not its specific production year — it can't tell a 2026 revival's director
 * from a same-titled 1990s production's director if both are attributable
 * online. Callers should pair this with an upstream production-year gate
 * (e.g. lookupIBDBDates()'s openingYear check in lib/ibdb-dates.js) rather
 * than assume this function verifies production identity, only name+role
 * attribution.
 *
 * @param {object} show - must have .title; .openingDate not required (pass year separately)
 * @param {Array<{name: string, role: string}>} proposed - candidate credits to verify
 * @param {string} year - production year for the SERP query (or 'upcoming')
 * @param {string} sourceTag - stamped onto each verified member's _source field
 */
async function verifyCreativeTeamViaSerp(show, proposed, year, sourceTag) {
  const verified = [];
  const seen = new Set(); // name+role dedup — a shared gate can't assume every caller pre-dedupes
  for (const member of proposed) {
    const name = String(member.name || '').trim();
    if (!name) {
      console.log(`    ❌ Blank/missing name for role "${member.role}" — rejecting`);
      continue;
    }
    const role = String(member.role || '').toLowerCase();
    const dedupeKey = `${role}::${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const verb = roleVerb(role);
    if (!verb) {
      console.log(`    ❌ Unrecognized role "${member.role}" for ${name} — rejecting (cannot SERP-verify)`);
      continue;
    }
    const canonRole = ROLE_CANON[role] || member.role;
    // "Music & Lyrics" is published inconsistently ("music and lyrics by" vs
    // "music & lyrics by") — accept either spelling for this one role rather
    // than widening every role to roleVerbVariants (which would weaken the
    // single-verb hallucination signal the other roles rely on).
    const phrases = role === 'music & lyrics' ? [verb, 'music & lyrics by'] : [verb];

    const query = `"${show.title}" ${year} "${verb} ${name}"`;
    console.log(`    🔍 Verifying: ${name} (${member.role}) via SERP...`);
    try {
      await sleep(500);
      const serpResults = await serpQuery(query);
      if (serpResults && serpResults.length > 0) {
        // Require the full phrase "directed by [name]" in a snippet — not just
        // the name — anchored to a segment naming this show (see the
        // serpTextConfirms doc comment above for the snippet-stitching failure
        // mode).
        const confirmed = serpTextConfirms(serpResults, phrases, name, { title: show.title });
        if (confirmed) {
          console.log(`    ✅ SERP confirmed: ${name} (${member.role})`);
          verified.push({ ...member, name, role: canonRole, _source: sourceTag });
        } else {
          console.log(`    ❌ SERP did not confirm: ${member.name} (${member.role}) — rejecting`);
        }
      } else {
        console.log(`    ❌ No SERP results for ${member.name} (${member.role}) — rejecting`);
      }
    } catch (e) {
      console.log(`    ⚠️  SERP verification failed for ${member.name}: ${e.message}`);
    }
  }

  return verified;
}

module.exports = { ROLE_CANON, roleVerb, roleVerbVariants, serpTextConfirms, titleTokens, normalizeForMatch, verifyCreativeTeamViaSerp };
