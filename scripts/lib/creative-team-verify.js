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
 * Whole-word containment for a title token. A plain substring check let the
 * one-letter title "G" (Royal Court 2024, by Tife Kusoro) anchor any snippet
 * containing a "g", which "confirmed" an invented Inua Ellams credit
 * (BRO-4884).
 */
function containsToken(text, token) {
  if (!token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(text);
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
    const pageTitleNamesShow = anchors.some(a => containsToken(pageTitle, a));
    // Google joins unrelated page fragments with "..." or "…" — treat each
    // fragment as its own evidence unit.
    const segments = snippet.split(/\.\.\.|…/);
    return segments.some(seg =>
      wanted.some(w => seg.includes(w)) &&
      (pageTitleNamesShow || anchors.some(a => containsToken(seg, a)))
    );
  });
}

/**
 * Roles whose holder changes from one production of a title to the next. A
 * play has one author across every staging; its director does not.
 */
const PRODUCTION_SPECIFIC_ROLES = new Set(['director', 'choreographer']);

/**
 * Lowercase tokens that name a production's venue in published coverage:
 * "Wyndham's Theatre" -> "wyndhams", "Theatre Royal Haymarket" -> "haymarket",
 * and a National Theatre stage also matches "national theatre". Apostrophes
 * are dropped (snippets write both "Wyndham's" and "Wyndhams"); tokens under
 * four characters are too common to anchor anything.
 */
function venueTokens(venue) {
  const v = normalizeForMatch(venue).replace(/'/g, '');
  if (!v) return [];
  const core = v
    .replace(/^the\s+/, '')
    .replace(/^theatre royal,?\s+/, '')
    .replace(/[,(].*$/, '')
    .replace(/\s+(theatre|theater|playhouse)$/, '')
    .replace(/^@/, '')
    .trim();
  const tokens = core.length >= 4 ? [core] : [];
  if (/^(lyttelton|olivier|dorfman)\b/.test(core) || /national theatre/.test(v)) tokens.push('national theatre');
  return [...new Set(tokens)];
}

/**
 * serpTextConfirms plus a production anchor: the confirming result must also
 * name this production's venue, in the same snippet segment or the page
 * title. Used for production-specific roles proposed by an LLM, where the
 * title-anchored check alone confirms the director of ANY staging of the
 * title. BRO-4884: the West End historical backfill wrote Dominic Cooke for
 * the 2019 Wyndham's Curtains (Paul Foster), Ivo van Hove for the 2019 Young
 * Vic Death of a Salesman (Marianne Elliott and Miranda Cromwell) and Roger
 * Michell for The Man in the White Suit (Sean Foley), each "SERP confirmed".
 */
function serpTextConfirmsProduction(serpResults, phrases, name, { title, venue } = {}) {
  const venues = venueTokens(venue);
  if (venues.length === 0 || !Array.isArray(serpResults)) return false;
  const nameN = normalizeForMatch(name);
  const wanted = phrases.map(p => `${normalizeForMatch(p)} ${nameN}`);
  const anchors = titleTokens(title);
  if (anchors.length === 0) return false;
  return serpResults.some(r => {
    const pageTitle = normalizeForMatch(r.title);
    const pageTitleNoApos = pageTitle.replace(/'/g, '');
    const segments = normalizeForMatch(r.snippet).split(/\.\.\.|…/);
    return segments.some(seg => {
      if (!wanted.some(w => seg.includes(w))) return false;
      const namesShow = anchors.some(a => containsToken(seg, a) || containsToken(pageTitle, a));
      const segNoApos = seg.replace(/'/g, '');
      const namesVenue = venues.some(t => segNoApos.includes(t) || pageTitleNoApos.includes(t));
      return namesShow && namesVenue;
    });
  });
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Shared SERP-verification gate for creative-team writes (moved here from
 * auto-fix-show-data.js; discover-new-shows.js, enrich-ibdb-dates.js and
 * backfill-playwright-credits.js already imported it from this module, where
 * it was never exported, so each of their calls threw).
 *
 * Every member needs a "<verb> <name>" snippet anchored to the show title.
 * With opts.productionAnchor (callers whose names were not taken from a
 * production-matched source, i.e. the LLM path), a director or choreographer
 * also needs the venue in that evidence, and the query names the venue; a
 * show with no usable venue gets no production-specific credits from it.
 *
 * @param {object} show
 * @param {Array<{name: string, role: string}>} proposed
 * @param {string} year
 * @param {string} sourceTag - written to each kept member's _source
 * @param {{productionAnchor?: boolean, serpQuery?: Function, sleep?: Function}} [opts]
 */
async function verifyCreativeTeamViaSerp(show, proposed, year, sourceTag, opts = {}) {
  const serpQuery = opts.serpQuery || require('./url-discovery').serpQuery;
  const sleep = opts.sleep || defaultSleep;
  const verified = [];
  const seen = new Set(); // name+role dedup — a shared gate can't assume every caller pre-dedupes
  for (const member of proposed || []) {
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
    const anchored = !!opts.productionAnchor && PRODUCTION_SPECIFIC_ROLES.has(role);
    if (anchored && venueTokens(show.venue).length === 0) {
      console.log(`    ❌ No venue to tie ${name} (${member.role}) to this production — rejecting`);
      continue;
    }

    const query = anchored
      ? `"${show.title}" ${show.venue} "${verb} ${name}"`
      : `"${show.title}" ${year} "${verb} ${name}"`;
    console.log(`    🔍 Verifying: ${name} (${member.role}) via SERP...`);
    try {
      await sleep(500);
      const serpResults = await serpQuery(query);
      if (serpResults && serpResults.length > 0) {
        // Require the full phrase "directed by [name]" in a snippet — not just
        // the name — anchored to a segment naming this show (and, when
        // anchored, its venue).
        const confirmed = anchored
          ? serpTextConfirmsProduction(serpResults, phrases, name, { title: show.title, venue: show.venue })
          : serpTextConfirms(serpResults, phrases, name, { title: show.title });
        if (confirmed) {
          console.log(`    ✅ SERP confirmed: ${name} (${member.role})`);
          verified.push({ ...member, name, role: canonRole, _source: sourceTag });
        } else {
          console.log(`    ❌ SERP did not confirm: ${member.name} (${member.role})${anchored ? ' at this venue' : ''} — rejecting`);
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

module.exports = {
  ROLE_CANON, roleVerb, roleVerbVariants, serpTextConfirms, titleTokens, normalizeForMatch,
  PRODUCTION_SPECIFIC_ROLES, venueTokens, serpTextConfirmsProduction, verifyCreativeTeamViaSerp, containsToken,
};
