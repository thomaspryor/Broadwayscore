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

Does the candidate synopsis describe THIS EXACT production (the one in the record above)? It is a MISMATCH if the synopsis is about a different show that merely shares the title, names different people/venue/year, or describes a plot inconsistent with this cast/era. If the record is too sparse to identify the production (e.g. cast, venue, and year are all unknown and the title is shared by multiple shows) so that you cannot confirm it, answer MISMATCH. If you are not fully confident it is the same production, answer MISMATCH.
Reply with ONLY one word on the FIRST line — either MATCH or MISMATCH (nothing else on that line). Put your one-sentence reason on the SECOND line.`;
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
  const firstLine = (text.split('\n')[0] || '').trim();
  // Reject-on-doubt, fail-closed:
  // 1. ANY mention of MISMATCH anywhere wins (covers "MATCH... actually MISMATCH").
  if (/\bMISMATCH\b/i.test(text)) return { match: false, reason: firstLine || 'mismatch' };
  // 2. MATCH passes ONLY if the verdict stands ALONE on the first line. A line
  //    like "MATCH - but the venue doesn't line up" is a hedge → fail closed
  //    (it does not match the anchored pattern). Trailing period/punct allowed.
  if (/^MATCH[.!]?$/i.test(firstLine)) return { match: true, reason: text.split('\n')[1]?.trim() || 'match' };
  // 3. Anything else (hedged "MATCH - ...", "Verdict: MATCH", empty, prose) → mismatch.
  return { match: false, reason: `unparseable/hedged verdict: ${firstLine.slice(0, 80)}` };
}

module.exports = { verifyProductionMatch, buildVerificationPrompt };
