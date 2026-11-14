'use strict';
/**
 * scored-other-critic.js (BRO-5420 follow-up): does a review's stored
 * llmScore evidence point at a critic other than the row's own?
 * dreamgirls-1981's AP review (Mary Campbell) was scored on the Douglas Watt
 * quote in its closing roundup: the reasoning read "the target critic Douglas
 * Watt's assessment is quoted directly at the end". Pure; a hand check decides.
 */

const QUOTED_VERDICT_RE = /\b(?:target critic|is quoted|quoted (?:directly|at the end|verdict)|critics'? roundup|other critics|wire piece|according to (?:the )?(?:critic|review))\b/i;
// "<First Last> said|says|calls|called|wrote|writes|found" or "<First Last>'s (assessment|verdict|review)"
const ATTRIBUTION_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){1,2})(?:\s+(?:said|says|calls|called|wrote|writes|found|finds|praised|panned)\b|['’]s\s+(?:assessment|verdict|review|take)\b)/g;
const NOT_PEOPLE = new Set(['The Times', 'New York', 'The Post', 'The Review', 'The Critic', 'Daily News', 'The Show']);

const surname = (name) => String(name || '').trim().split(/\s+/).pop().toLowerCase();

function otherCriticEvidence(record) {
  const s = record && record.llmScore;
  if (!s) return null;
  const critic = String(record.criticName || '');
  const own = surname(critic);
  const reasoning = String(s.reasoning || '');
  const quotes = (Array.isArray(s.keyPhrases) ? s.keyPhrases : []).map((k) => String((k && k.quote) || ''));
  const m = QUOTED_VERDICT_RE.exec(reasoning);
  if (m) return { kind: 'reasoning-says-quoted', match: m[0] };
  for (const text of [reasoning, ...quotes]) {
    ATTRIBUTION_RE.lastIndex = 0;
    let a;
    while ((a = ATTRIBUTION_RE.exec(text)) !== null) {
      const who = a[1];
      if (NOT_PEOPLE.has(who) || /^(?:Claude|Gemini|Openai|Gpt|All|The|This|Both|Critic)\b/i.test(who)) continue;
      if (own && surname(who) === own) continue;
      if (critic && critic.toLowerCase() !== 'unknown' && who.toLowerCase().includes(own)) continue;
      return { kind: text === reasoning ? 'reasoning-attributes-other' : 'keyphrase-attributes-other', match: a[0] };
    }
  }
  return null;
}

module.exports = { otherCriticEvidence };
