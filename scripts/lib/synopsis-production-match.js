/**
 * Wrong-show verification gate for generated/scraped synopses.
 *
 * Why this exists: LLM synopsis generation (and Wikipedia matching) confidently
 * produce the WRONG same-titled show's plot for ambiguous titles, and
 * isValidSynopsis CANNOT detect it — the text is well-formed, just about a
 * different production. Concrete trap (2026-06-21): both Haiku AND Opus wrote
 * the 2024 Laura Winters play "All of Me" plot for the 2010 Dame Edna revue
 * "All About Me", even with the cast in the prompt. The "reply UNKNOWN if
 * uncertain" escape hatch does not fire because the model is confidently wrong.
 *
 * The gate: before persisting any synopsis, ask a strong classifier (Opus —
 * Gemini hallucinates isValid:true on garbage, see feedback_llm_verifier_*) to
 * confirm the text describes THIS production (title/year/venue/cast). Reject on
 * any doubt. Validated 4/4 on a golden set incl. the All About Me / All of Me
 * trap and a synthetic wrong-plot case (see scripts/lib/synopsis-production-match.eval.mjs).
 *
 * callLLM is dependency-injected (prompt -> Promise<string>) so the parsing /
 * reject-on-doubt logic is unit-testable without an API call.
 */

function buildVerificationPrompt(show, synopsis) {
  const cast = (show.cast || []).map(c => c.name).filter(Boolean).join(', ');
  const team = (show.creativeTeam || []).map(c => `${c.name} (${c.role})`).join(', ');
  const year = (show.openingDate || '').slice(0, 4) || '?';
  return `You are verifying whether a synopsis describes a SPECIFIC theatrical production. Many shows share a title, so be strict.

PRODUCTION RECORD (the ground truth):
- Title: ${show.title}
- Year: ${year}
- Type: ${show.type || '?'}
- Venue: ${show.venue || '?'}
- Cast: ${cast || '(unknown)'}
- Creative team: ${team || '(unknown)'}

CANDIDATE SYNOPSIS:
"${synopsis}"

Does the candidate synopsis describe THIS EXACT production (the one in the record above)? It is a MISMATCH if the synopsis is about a different show that merely shares the title, names different people/venue/year, or describes a plot inconsistent with this cast/era. If you are not confident it is the same production, answer NO.
Answer on the first line with exactly MATCH or MISMATCH, then one sentence why.`;
}

/**
 * @param {object} show - show record (title, openingDate, type, venue, cast, creativeTeam)
 * @param {string} synopsis - candidate synopsis text
 * @param {(prompt: string) => Promise<string>} callLLM - injected strong-model call
 * @returns {Promise<{match: boolean, reason: string}>}
 */
async function verifyProductionMatch(show, synopsis, callLLM) {
  if (!synopsis || typeof synopsis !== 'string') return { match: false, reason: 'empty synopsis' };
  if (typeof callLLM !== 'function') return { match: false, reason: 'no verifier available' };

  let raw;
  try {
    raw = await callLLM(buildVerificationPrompt(show, synopsis));
  } catch (e) {
    return { match: false, reason: `verifier error: ${e && e.message}` };
  }

  const text = (raw || '').trim();
  // Reject-on-doubt: only an explicit, unambiguous MATCH passes.
  if (/^\s*MISMATCH\b/i.test(text)) return { match: false, reason: text.split('\n')[0] };
  if (/^\s*MATCH\b/i.test(text)) return { match: true, reason: text.split('\n')[0] };
  // Unparseable / empty / hedged → treat as mismatch (fail-safe).
  return { match: false, reason: `unparseable verdict: ${text.slice(0, 80)}` };
}

module.exports = { verifyProductionMatch, buildVerificationPrompt };
