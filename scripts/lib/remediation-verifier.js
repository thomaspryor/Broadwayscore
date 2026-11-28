'use strict';
// BRO-7608: pure helpers for the remediation-plan fact-check (second LLM).
// gpt-4o-mini anchors on stored show data over instructions, so a plan that
// REPLACES a reader-disputed value (e.g. director Clurman -> Rafaeli) was
// failed for "contradicting" the very value being corrected. Fix: the verifier
// never sees the value a plan edits (redactDisputedFields) and is told that
// id years are the season added, not the openingDate year.

function parseJsonFence(part) {
  const m = part.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Plan field -> top-level key (+ optional nested path) in the show JSON.
function fieldPath(field) {
  return String(field || '').split('.').filter(Boolean);
}

function deleteAt(obj, pathParts) {
  if (!obj || typeof obj !== 'object' || pathParts.length === 0) return false;
  const [head, ...rest] = pathParts;
  if (rest.length === 0) {
    if (Array.isArray(obj) && /^\d+$/.test(head)) { obj.splice(Number(head), 1); return true; }
    if (head in obj) { delete obj[head]; return true; }
    return false;
  }
  return deleteAt(obj[head], rest);
}

// Returns { context, redacted:[fields] }. Show Data blocks only; other parts untouched.
function redactDisputedFields(showContext, plan) {
  const edits = ((plan && plan.actions) || []).filter(a => a && a.type === 'data-edit' && a.field && a.showId && (!a.file || a.file === 'shows.json'));
  if (!showContext || edits.length === 0) return { context: showContext || '', redacted: [] };
  const redacted = [];
  const out = String(showContext).split(/\n\n(?=## )/).map(part => {
    if (!part.startsWith('## Show Data')) return part;
    const data = parseJsonFence(part);
    if (!data) return part;
    let changed = false;
    for (const e of edits) {
      if (e.showId !== data.id) continue;
      if (deleteAt(data, fieldPath(e.field))) { changed = true; redacted.push(e.field); }
    }
    if (!changed) return part;
    const header = part.split('\n')[0];
    return `${header}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }).join('\n\n');
  return { context: out, redacted: [...new Set(redacted)] };
}

function buildVerifierPrompt(plan, diagnosis, showContext) {
  const { context, redacted } = redactDisputedFields(showContext, plan);
  const disputedNote = redacted.length
    ? `\nNote: the field(s) this plan edits (${redacted.join(', ')}) were deliberately removed from the show data below because the reader disputes their stored value. Do NOT flag a plan for changing them, and do not treat their absence as a problem; judge the new value only for plausibility against the diagnosis and the remaining data.\n`
    : '';
  return `You are fact-checking a proposed data fix for Broadway Scorecard. Your ONLY job is to check for factual errors — wrong production years, wrong show IDs, or claims that contradict the show data provided.

## Proposed Fix
**Summary:** ${plan.summary}
**Steps:** ${(plan.steps || []).join('; ')}
**Actions:** ${JSON.stringify(plan.actions, null, 2)}

## Original Diagnosis
${diagnosis.summary}
${diagnosis.whatsHappening}
${disputedNote}
## Show Data From Our Database
${context || '(no show data available)'}

## Instructions
1. Check each action's showId — does it match a real show in the data?
2. Show IDs end in a year: that is the season the entry was added, NOT the opening year. A later openingDate (e.g. id "-2026" with openingDate 2027-01-07) is normal and is NOT an issue.
3. The reader's report is the reason for the fix. If the diagnosis says a value is wrong and names the correct one, a plan that sets that value is correct. The new value only has to match the diagnosis; it does NOT need to appear in the show data, and you must not fail it as "unverified".
4. Fail ONLY for a plan that targets the wrong show or production (different show, different year/revival than the diagnosis names), or invents a showId not in the data.
5. If the show data doesn't include the claimed show, flag it as UNVERIFIED (not necessarily wrong, just can't confirm)

Respond with ONLY a JSON object:
{
  "passed": true/false,
  "issues": ["Issue 1", "Issue 2"],
  "confidence": "high|medium|low"
}

If everything looks correct, return {"passed": true, "issues": [], "confidence": "high"}.`;
}

module.exports = { buildVerifierPrompt, redactDisputedFields };
