'use strict';

/**
 * Web-search grounding for an LLM synopsis the fast model could not write.
 *
 * auto-fix-show-data.js asks Haiku first and falls back to Opus when Haiku
 * replies UNKNOWN. For a classic that fallback is right (Haiku balked at a
 * one-woman Dorian Gray). For a little-known new play it is a guess: Opus
 * wrote an emo/My Chemical Romance plot about a dead father for
 * instructions-for-a-teenage-armageddon-west-end-2024, whose story is a girl
 * grieving her sister, and the Opus wrong-show check passed it, because a
 * model cannot catch its own confident invention (BRO-4884). So a fallback
 * synopsis is kept only when search results about this production support it.
 */

function buildGroundingQuery(show) {
  const year = (show.openingDate || show.previewsStartDate || '').slice(0, 4);
  return [`"${show.title}"`, show.venue || '', year, 'review'].filter(Boolean).join(' ');
}

function formatResults(results, max = 8) {
  return (results || [])
    .filter(r => r && (r.title || r.snippet))
    .slice(0, max)
    .map((r, i) => `${i + 1}. ${String(r.title || '').trim()}\n   ${String(r.snippet || '').trim()}`)
    .join('\n');
}

function buildGroundingPrompt(show, synopsis, results) {
  return `You are checking a theatre synopsis against web search results. The search results below are the evidence. Use your own knowledge only to recall the story of a published source the results name, never to fill in a story the results do not identify.

Production: "${show.title}" at ${show.venue || 'an unknown venue'}${show.openingDate ? ` (${show.openingDate.slice(0, 4)})` : ''}

Synopsis to check:
"""${synopsis}"""

Search results:
${formatResults(results)}

Do the search results describe the same story as the synopsis: the same central character(s) and the same core situation?
- SUPPORTED: the results describe the synopsis's central premise. Also SUPPORTED when the results name a published source this production adapts (a novel, film, TV series, memoir or earlier play, e.g. "adapted from Virginia Woolf's novel") and the synopsis tells that source's story as you know it, with nothing in the results conflicting.
- CONTRADICTED: the results describe a different premise, different central characters, or details that conflict with the synopsis; or the synopsis does not match the named source's story.
- UNSUPPORTED: the results neither say what the story is about nor name a published source it adapts. A new original play with no plot in the results is UNSUPPORTED, however plausible the synopsis sounds.
Reply with exactly one word, SUPPORTED, CONTRADICTED or UNSUPPORTED, then a colon and one short reason.`;
}

/** Only an explicit SUPPORTED keeps the synopsis; anything else, including an unparseable reply, drops it. */
function parseGroundingVerdict(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^\W*(SUPPORTED|CONTRADICTED|UNSUPPORTED)\b\s*:?\s*(.*)$/is);
  if (!m) return { supported: false, verdict: 'UNPARSEABLE', reason: raw.slice(0, 160) };
  const verdict = m[1].toUpperCase();
  return { supported: verdict === 'SUPPORTED', verdict, reason: m[2].trim().slice(0, 200) };
}

/**
 * @param {object} show
 * @param {string} synopsis
 * @param {{ search: (q: string) => Promise<Array<{title?: string, snippet?: string}>|null>, judge: (prompt: string) => Promise<string|null> }} deps
 * @returns {Promise<{supported: boolean, verdict: string, reason: string}>}
 */
async function groundSynopsis(show, synopsis, { search, judge }) {
  let results;
  try { results = await search(buildGroundingQuery(show)); } catch (e) { results = null; }
  const usable = (results || []).filter(r => r && r.snippet);
  if (!usable.length) return { supported: false, verdict: 'NO_RESULTS', reason: 'no search snippets to check against' };
  let reply;
  try { reply = await judge(buildGroundingPrompt(show, synopsis, usable)); } catch (e) { reply = null; }
  return parseGroundingVerdict(reply);
}

module.exports = { buildGroundingQuery, buildGroundingPrompt, parseGroundingVerdict, groundSynopsis };
