// The LLM review prompt for scripts/visual-qa.mjs, kept apart so it can be
// tested without launching a browser.
//
// Per-ref roles (--ref-roles) change the PASS criterion. 'goal' (default):
// the implementation must match the reference. 'before': the reference is the
// state the user asked to CHANGE, so the implementation must differ from it.
// BRO-5548: with the BEFORE override appended after the checklist, gpt-5.4-mini
// applied the checklist's copy-mismatch and missing-element failures to the
// BEFORE screenshot and failed the requested change twice ("the implementation
// shows How It Works instead of the reference card"). The override now comes
// first and scopes those checks to GOAL references; a BEFORE-only run gets
// BEFORE_ONLY_PROMPT instead (the override alone did not stop it).

export const REVIEW_CHECKLIST = `You are comparing an IMPLEMENTATION screenshot to a REFERENCE design image.

CRITICAL ANTI-HALLUCINATION RULES:
- If the two images appear IDENTICAL or near-identical, return {"verdict": "PASS", "issues": []}.
- If you cannot identify a SPECIFIC, NAMEABLE difference with a quoted text snippet or a measurable
  visual property (color hex/pill width/etc.), DO NOT INVENT ONE. Return PASS.
- Vision models commonly hallucinate small numeric/text differences in show titles, scores, dates —
  if you find yourself listing "score X in ref vs Y in impl" for many items, you are HALLUCINATING.
  Stop and return PASS unless you can quote the exact pixel coordinates where the difference appears.
- The reference image and the implementation may differ in dynamic content (today's date, scores
  that change with new data). DO NOT flag dynamic content differences. Flag only LAYOUT, COPY,
  STYLING, COLOR, and TYPOGRAPHY issues.
- IMPLEMENTATION images may be tight crops of single components, while the REFERENCE shows a full page.
  Compare each crop only to the matching region of the REFERENCE;
  never report elements outside the crop as missing.
- If the reference shows a single UI component (a card, a pill, a section) and the implementation
  shows a full page, look ONLY at the implementation region that corresponds to the reference.

Return ONLY a JSON object: {"verdict": "PASS" | "FAIL", "issues": ["specific issue 1", ...]}.
No markdown wrapper, no commentary, no leading text.

HARD FAILURES (auto FAIL — must be specific & quotable):
1. Copy mismatch — STATIC text content differs (label, button text, headline).
   Example: design says "HISTORICAL ACCURACY", implementation says "ACCURACY" → FAIL.
   NOT a failure: show titles, scores, dates (those are dynamic data).
2. Typography case mismatch — UPPERCASE in design rendered as lowercase (or vice versa),
   tracked letter-spacing dropped, font weight obviously changed.
3. Missing element — design shows a UI element implementation does not render at all.
4. Layout overflow — content extends past viewport/container; text VISIBLY clipped/cut-off (not
   just truncated with ellipsis); horizontal scroll where there shouldn't be one.
5. Tap-target violation on mobile widths (≤414) — interactive element height < 44px.

SOFT SIGNALS (note but only FAIL if severe):
6. Color/glow intensity dramatically different (e.g., gold pill vs no gold pill).
7. Proportion >25% off.
8. Border-radius mismatch only if visually jarring.

If you cannot see one of the images, return {"verdict": "FAIL", "issues": ["could not load image: <which one>"]}.`;

// What "the change did not land" means in a BEFORE-only run. Judged on the whole visible implementation, not just its top
// (a label rename or a tier move below the fold is a real change).
const SAME_AS_BEFORE_RULE = `sameAsBefore: compare the implementation with the matching region of the BEFORE
image. If the implementation is a crop of one component, compare only that region.
Ignore dynamic content (dates, scores, standings, prices that track data).
Name the clearest visible non-dynamic difference in "difference" (quote the text or
describe the element, e.g. "heading reads 'X' instead of 'Y'", "section Z moved below W").
Any visible difference counts: a moved or removed section, a renamed label, a different
color or tier. If you cannot name one, set "difference" to "" and sameAsBefore to true:
identical or near-identical images mean the change did not land.`;

// The reply shape for BEFORE-only runs (parseVerdictJson requires both extra
// fields then).
const BEFORE_REPLY_SHAPE = '{"difference": "<the difference, or empty>", "sameAsBefore": true | false, "verdict": "PASS" | "FAIL", "issues": ["specific issue 1", ...]}';

// A run whose only references are BEFORE screenshots gets its own prompt with
// no matching checklist: with the checklist present (even behind an override)
// gpt-5.4-mini still failed the requested change as a "copy mismatch".
export const BEFORE_ONLY_PROMPT = `The user asked for a change to the page shown in the BEFORE reference image(s).
The IMPLEMENTATION screenshots show the page after the change, at several widths, and
may be crops of single components. Do not try to make the implementation match the BEFORE
image: different text, order or sections are usually the change the user asked for.

${SAME_AS_BEFORE_RULE}
If sameAsBefore is true, the change did not land: the verdict MUST be FAIL with the issue
"change did not land".

Otherwise FAIL only for one of these, and quote what you see:
1. Layout overflow: content extends past the viewport or container, or text is VISIBLY
   clipped or cut off (not just truncated with an ellipsis); horizontal scroll.
2. Tap-target violation on mobile widths (<=414): an interactive element under 44px tall.
3. Something visibly broken in the implementation itself: overlapping elements, unreadable
   contrast, an empty area where content clearly failed to render.
4. Site chrome the BEFORE image shows (navigation header, footer) missing from a full-page
   implementation screenshot.
If none of these applies, return PASS. Do not invent problems.

Reply with the JSON object only, no reasoning before or after it:
${BEFORE_REPLY_SHAPE}
If you cannot see one of the images, return {"difference": "", "sameAsBefore": false, "verdict": "FAIL", "issues": ["could not load image: <which one>"]}.`;

export function rolePromptHeader(refRoles) {
  if (!refRoles || !refRoles.includes('before')) return REVIEW_CHECKLIST;
  if (refRoles.every(r => r === 'before')) return BEFORE_ONLY_PROMPT;
  // With a GOAL reference in the run, matching it is what proves the change
  // landed, so no sameAsBefore judgment here (asked for one, gpt-5.4-mini
  // called a correct change "did not land" 3 runs in 3).
  return `READ THIS FIRST: it overrides the checklist below.
Each reference image is labelled GOAL or BEFORE.
- GOAL: the state to match. The checklist applies as written, and matching a GOAL
  reference is what shows the requested change landed.
- BEFORE: the state the user asked to CHANGE. Differences from a BEFORE reference
  (text, headlines, sections, order, case, weight, color) are the requested change,
  never a failure. HARD FAILURES 1-3 and SOFT SIGNALS 6-8 compare against GOAL
  references only.
- HARD FAILURES 4 (overflow or clipping) and 5 (tap targets) always apply to the
  implementation itself.
- If the implementation looks like the BEFORE reference rather than the GOAL
  reference, the change did not land: FAIL with the issue "change did not land".
  The "identical means PASS" rule below is about matching a GOAL reference, never
  a BEFORE one.

` + REVIEW_CHECKLIST;
}

/**
 * Parse a reviewer's JSON verdict; throws on anything malformed (the caller
 * retries, then records a provider error). With `beforeOnly` (every reference
 * is a BEFORE screenshot, so BEFORE_ONLY_PROMPT was used) the reply must carry
 * a boolean sameAsBefore; true, or false with no named difference, forces
 * FAIL: the change did not land.
 */
export function parseVerdictJson(content, { beforeOnly = false } = {}) {
  // LLMs sometimes wrap JSON in ```json ... ``` or add a sentence around it
  // despite instructions; take the outermost {...}.
  let s = String(content).trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  let parsed;
  try { parsed = JSON.parse(s); }
  catch (err) {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    try { parsed = JSON.parse(s.slice(first, last + 1)); }
    catch { throw new Error(`Invalid JSON in verdict: ${err.message} — content was: ${s.slice(0, 200)}`); }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Verdict is not an object');
  if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') throw new Error(`Verdict must be "PASS" or "FAIL", got "${parsed.verdict}"`);
  if (!Array.isArray(parsed.issues)) throw new Error('Issues must be an array');
  const issues = parsed.issues.map(String);
  if (beforeOnly) {
    const raw = parsed.sameAsBefore;
    const same = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
    if (same === null) throw new Error(`BEFORE reference run: sameAsBefore must be true or false, got ${JSON.stringify(raw)}`);
    // "Different" with no named difference is how gpt-5.4-mini waved through
    // an implementation identical to the BEFORE image (1 run in 3).
    const named = typeof parsed.difference === 'string' && parsed.difference.trim().length > 0;
    if (same || !named) return { verdict: 'FAIL', issues: parsed.verdict === 'FAIL' && same ? issues : ['change did not land (no visible difference from BEFORE named)', ...issues] };
  }
  return { verdict: parsed.verdict, issues };
}
