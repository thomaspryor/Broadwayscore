'use strict';

/**
 * Search grounding for a creative-team credit the model proposed from memory.
 *
 * auto-fix-show-data.js asks a model for a show's creative team, then keeps a
 * name when a SERP snippet reads "<title> ... <verb> <name>". That phrase check
 * cannot tell productions or similarly titled works apart: it kept Lucy
 * Kirkwood for The Glow and Middle (Alistair McDowall, David Eldridge), Will
 * Butler as Stereophonic's playwright (David Adjmi), Adam Guettel for The
 * Outsiders' lyrics (Jamestown Revival) and directors of other stagings
 * across every market (BRO-4884). So a model-proposed credit is kept only when
 * search results about THIS production name that person in that role.
 */

function buildCreditQuery(show, role) {
  const year = (show.openingDate || show.previewsStartDate || '').slice(0, 4);
  return [`"${show.title}"`, show.venue || '', year, String(role || '').toLowerCase()].filter(Boolean).join(' ');
}

function formatResults(results, max = 8) {
  return (results || [])
    .filter(r => r && (r.title || r.snippet))
    .slice(0, max)
    .map((r, i) => `${i + 1}. ${String(r.title || '').trim()}\n   ${String(r.snippet || '').trim()}`)
    .join('\n');
}

function buildCreditPrompt(show, member, results) {
  const year = (show.openingDate || show.previewsStartDate || '').slice(0, 4);
  return `You are checking one theatre credit against web search results. The search results are the evidence; do not rely on your own memory of who wrote or directed a show.

Production: "${show.title}" at ${show.venue || 'an unknown venue'}${year ? ` (${year})` : ''}
Claimed credit: ${member.name} as ${member.role}

Search results:
${formatResults(results)}

Do the results show ${member.name} as ${member.role} of this production (or, for an author, of the work this production stages)?
- SUPPORTED: a result credits ${member.name} in that role for this show.
- CONTRADICTED: a result credits someone else in that role for this production or work, or ties ${member.name} to a different show or production.
- UNSUPPORTED: the results do not say who holds that role.
Reply with exactly one word, SUPPORTED, CONTRADICTED or UNSUPPORTED, then a colon and one short reason.`;
}

/** Only an explicit SUPPORTED keeps the credit; anything else drops it. */
function parseCreditVerdict(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^\W*(SUPPORTED|CONTRADICTED|UNSUPPORTED)\b\s*:?\s*(.*)$/is);
  if (!m) return { supported: false, verdict: 'UNPARSEABLE', reason: raw.slice(0, 160) };
  const verdict = m[1].toUpperCase();
  return { supported: verdict === 'SUPPORTED', verdict, reason: m[2].trim().slice(0, 200) };
}

/**
 * @param {object} show
 * @param {{name: string, role: string}} member
 * @param {{ search: (q: string) => Promise<Array<{title?: string, snippet?: string}>|null>, judge: (prompt: string) => Promise<string|null> }} deps
 */
async function groundCredit(show, member, { search, judge }) {
  let results;
  try { results = await search(buildCreditQuery(show, member.role)); } catch (e) { results = null; }
  const usable = (results || []).filter(r => r && r.snippet);
  if (!usable.length) return { supported: false, verdict: 'NO_RESULTS', reason: 'no search snippets to check against' };
  let reply;
  try { reply = await judge(buildCreditPrompt(show, member, usable)); } catch (e) { reply = null; }
  return parseCreditVerdict(reply);
}

module.exports = { buildCreditQuery, buildCreditPrompt, parseCreditVerdict, groundCredit };
