#!/usr/bin/env node
/**
 * Fixtures for stripLeadingChrome (scripts/lib/pull-quote-guards.js).
 *
 * Covers the 5 cases from Session C / Lost Boys 2026-04-26 postmortem
 * Issue #9 (Gap 5):
 *   1. NYT-style header chrome (By Author + Photo credit + venue)
 *   2. Exeunt-style header chrome — real Lost Boys text — must start the
 *      pullquote at "This vampire musical succeeds on spectacle..."
 *   3. Byline-then-narrative (just-a-name line followed by the review body)
 *   4. All-narrative — no chrome — heuristic is a no-op (returns first 600
 *      chars of original)
 *   5. Chrome-only — heuristic should bail (return null) so the caller
 *      uses the original raw slice rather than slicing at the wrong place
 *
 * Run:
 *   node scripts/test-pull-quote-chrome-skip.js
 *
 * Exit: 0 on pass, 1 on fail.
 */

'use strict';

const { stripLeadingChrome } = require('./lib/pull-quote-guards');

const cases = [];
let failures = 0;

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
  cases.push({ name, ok: !!cond });
}

// ---------------------------------------------------------------------------
// Case 1: NYT-style header chrome
// ---------------------------------------------------------------------------
console.log('Case 1: NYT-style header chrome');
{
  const text = [
    'Review: A New Hamlet Finds Its Footing in Brooklyn',
    'By Jesse Green',
    'Photo: Sara Krulwich/The New York Times',
    'Booth Theatre',
    '',
    'In a season already crowded with revivals, this Hamlet stands apart for its quiet intelligence. The director resists the usual gestures and lets the language breathe. Performances are uniformly strong, with the title role anchored in a still, watchful presence that pays off in the play\'s closing scenes.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string', `got ${typeof out}: ${out}`);
  assert('starts at narrative ("In a season")', out && out.startsWith('In a season already crowded'), `got: ${JSON.stringify(out?.slice(0, 80))}`);
  assert('does not contain "Review:"', out && !/Review:/i.test(out));
  assert('does not contain "By Jesse Green"', out && !/By Jesse Green/i.test(out));
  assert('does not contain "Photo:"', out && !/Photo:/i.test(out));
}

// ---------------------------------------------------------------------------
// Case 2: Exeunt-style header chrome — real Lost Boys 2026 fixture
// ---------------------------------------------------------------------------
console.log('Case 2: Exeunt-style header chrome (Lost Boys 2026)');
{
  // Lifted verbatim from data/review-texts/the-lost-boys-2026/exeunt-magazine--loren-noveck.json
  const text = [
    'Review: The Lost Boys: The Musical at the Palace Theatre',
    'Palace Theatre ⋄ March 27, 2026-open-ended',
    'This vampire musical succeeds on spectacle, but belabors its themes. Loren Noveck reviews.',
    '',
    'Loren Noveck',
    'LJ Benet, Ali Louis Bourzgui, and the company of The Lost Boys. Photo: Matthew Murphy',
    'LJ Benet, Ali Louis Bourzgui, and the company of The Lost Boys. Photo: Matthew Murphy',
    '',
    'It is telling that the website for The Lost Boys, a new musical adaptation of the 1980s horror comedy film, features only the vampire ensemble.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string', `got ${typeof out}: ${out}`);
  assert(
    'starts at "This vampire musical succeeds..."',
    out && out.startsWith('This vampire musical succeeds on spectacle'),
    `got: ${JSON.stringify(out?.slice(0, 80))}`
  );
  assert('does not contain "Review:" prefix', out && !out.startsWith('Review:'));
  assert('does not contain "Palace Theatre ⋄"', out && !/Palace Theatre\s+⋄/.test(out));
}

// ---------------------------------------------------------------------------
// Case 3: byline-then-narrative
// ---------------------------------------------------------------------------
console.log('Case 3: byline-then-narrative');
{
  const text = [
    'Sara Holdren',
    'The new musical at the Cort delivers exactly what its title promises and not much more. The score is tuneful, the staging is brisk, and the cast attacks every number with conviction.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string');
  assert('starts at "The new musical"', out && out.startsWith('The new musical at the Cort'),
    `got: ${JSON.stringify(out?.slice(0, 80))}`);
  assert('does not contain "Sara Holdren"', out && !/Sara Holdren/.test(out));
}

// ---------------------------------------------------------------------------
// Case 4: all-narrative (no chrome) — heuristic is a no-op
// ---------------------------------------------------------------------------
console.log('Case 4: all-narrative (no chrome — no-op)');
{
  const text = 'This production starts strong and never lets up. The first-act finale is one of the most thrilling stretches of musical theater in recent memory, and the second act somehow tops it. By curtain, the audience was on its feet — and so was I.';

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string');
  assert('returns the original text (no chrome stripped)', out === text,
    `got: ${JSON.stringify(out?.slice(0, 80))}`);
}

// ---------------------------------------------------------------------------
// Case 5: chrome-only (no narrative line) — heuristic bails
// ---------------------------------------------------------------------------
console.log('Case 5: chrome-only (heuristic bails)');
{
  const text = [
    'Review: Some Show at Some Theatre',
    'By Anonymous Author',
    'Photo: Some Photographer',
    'Booth Theater',
    '12/31/2025',
    'Joe Smith',
    'Jane Doe',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns null (bail signal)', out === null, `got: ${JSON.stringify(out)}`);
}

// ---------------------------------------------------------------------------
// Case 6: chrome line that satisfies narrative shape (Codex P1 regression)
// ---------------------------------------------------------------------------
console.log('Case 6: chrome line satisfying narrative shape (chrome-first ordering)');
{
  // "By Jesse Green for The New York Times." — 8 words, ends with period.
  // Without chrome-first ordering, isNarrativeLine would return true and the
  // heuristic would NOT strip it.
  const text = [
    'By Jesse Green for The New York Times.',
    'This new musical at the Booth somehow earns its applause and its tears.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string');
  assert('starts at "This new musical"', out && out.startsWith('This new musical'),
    `got: ${JSON.stringify(out?.slice(0, 80))}`);
  assert('does not contain "By Jesse Green"', out && !/By Jesse Green/.test(out));
}

// ---------------------------------------------------------------------------
// Case 7: multi-word venue (Codex P1 — venue regex broadened)
// ---------------------------------------------------------------------------
console.log('Case 7: multi-word venue line ("New Amsterdam Theatre", "St James Theatre")');
{
  const text = [
    'Review: A New Show at the New Amsterdam',
    'New Amsterdam Theatre',
    'St James Theatre',
    'Lincoln Center Theater',
    'In a season of revivals, this new piece feels genuinely new.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string');
  assert('starts at "In a season"', out && out.startsWith('In a season'),
    `got: ${JSON.stringify(out?.slice(0, 80))}`);
  assert('does not contain "New Amsterdam Theatre"', out && !/New Amsterdam Theatre/.test(out));
  assert('does not contain "St James Theatre"', out && !/St James Theatre/.test(out));
  assert('does not contain "Lincoln Center Theater"', out && !/Lincoln Center Theater/.test(out));
}

// ---------------------------------------------------------------------------
// Case 8: ambiguous starter that previously slipped through
//         ("Now playing at..." was in NARRATIVE_STARTER_RE — removed)
// ---------------------------------------------------------------------------
console.log('Case 8: removed ambiguous starters ("Now"/"From"/"As"/"But") no longer steal the strip');
{
  // "Now playing at the Booth Theater" was previously classified as narrative
  // because of the "Now" starter. After P1 fix it falls through to ambiguous
  // (neither chrome nor narrative starter), stops the strip safely, but the
  // earlier "Booth Theater" line should still be skipped.
  const text = [
    'Review: Some Show',
    'Booth Theater',
    'Now playing at the Booth Theater through June 2026.',
    'In its third week, the production has settled into a confident rhythm.',
  ].join('\n');

  const out = stripLeadingChrome(text, { maxLen: 600 });
  assert('returns a string', typeof out === 'string');
  // The safer behavior: stop at the ambiguous "Now playing..." line rather
  // than skipping it and risking the wrong narrative pick.
  assert('does not start with "Review:" chrome', out && !out.startsWith('Review:'));
  assert('does not start with "Booth Theater" venue', out && !out.startsWith('Booth Theater'));
}

// ---------------------------------------------------------------------------

console.log('');
const total = cases.length;
const passed = total - failures;
if (failures > 0) {
  console.log(`✗ ${failures}/${total} assertions failed`);
  process.exit(1);
} else {
  console.log(`✓ ${passed}/${total} assertions passed`);
  process.exit(0);
}
