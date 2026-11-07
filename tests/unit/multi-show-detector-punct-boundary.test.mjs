/**
 * multi-show-detector — countMentions punctuation-tolerant boundary
 *
 * Background (issue #316): The original detector used `\b{title}\b`. The
 * trailing `\b` requires a word ↔ non-word transition; for titles ending in
 * punctuation (Schmigadoon!, Hello, Dolly!, Oklahoma!), the regex looks for a
 * word character after the `!` (a non-word char), finds whitespace (non-word),
 * and silently returns 0 mentions. ~90 shows in the catalogue have trailing
 * punctuation. The May 2026 NYer joint Schmigadoon!/Lost Boys review missed
 * detection because of this bug — the file got stuck in wrongShow:true and
 * never landed in reviews.json on the Lost Boys page.
 *
 * Fix: replace `\b` with non-alphanumeric lookbehind/lookahead so the boundary
 * works regardless of whether the title's edges are letters, digits, or
 * punctuation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load TS module via ts-node/register or tsx loader. Test runner config
// expects Node to be invoked with `--import tsx/esm` (set in test.yml).
const detectorPath = path.resolve(
  __dirname,
  '../../scripts/llm-scoring/multi-show-detector.ts',
);

describe('multi-show-detector — trailing punctuation in show titles', () => {
  // Short snippet that mentions Schmigadoon! 7 times so it crosses the
  // detector's 5-mention "other show" threshold and the 7-mention
  // "comparison article" threshold (joint review pattern).
  const JOINT_REVIEW_TEXT = `
The frothy, delectable "Schmigadoon!" is a love letter to the form. Reviewing
Schmigadoon! is reviewing the entire mid-century Broadway canon — the show
delights in pastiche. Watching Schmigadoon! after years of streaming the
Apple TV series, I was struck by how much the cast leaned into the bit.
Schmigadoon! works in part because the writers respect the source.
Schmigadoon! is at its sharpest when it tweaks the tradition's sillier motifs.
And yet, Schmigadoon! is just half of tonight's double bill. The Lost Boys is
the other half — a vampire musical with a staggering budget and very little
camp. Schmigadoon! ends; The Lost Boys begins, and the contrast couldn't be
starker. Where Schmigadoon! plays earnest, The Lost Boys plays loud.
The Lost Boys never stops moving, kinetic and poetic at once. The Lost Boys
is risk-free I.P., easy to mock, hard to defend on purist grounds. The Lost
Boys, like Buffy before it, swaps camp for mythology. The Lost Boys cast is
excellent across the board.
`.repeat(1);

  test('counts Schmigadoon! mentions (trailing-! title) in joint review text', async () => {
    const { detectMultiShow } = await import(detectorPath);
    const result = detectMultiShow(JOINT_REVIEW_TEXT, 'the-lost-boys-2026');

    // The bug: pre-fix this returned otherShows: [] because \bSchmigadoon!\b
    // matched 0 times.
    const schmig = result.otherShows.find(
      (s) => s.title === 'schmigadoon!' || s.title === 'Schmigadoon!',
    );
    assert.ok(
      schmig,
      `Expected Schmigadoon! to appear in otherShows. Got: ${JSON.stringify(result.otherShows)}`,
    );
    assert.ok(
      schmig.mentions >= 5,
      `Expected ≥5 mentions of Schmigadoon!, got ${schmig?.mentions}`,
    );
  });

  test('regression: titles without trailing punctuation still match', async () => {
    const { detectMultiShow } = await import(detectorPath);
    // Use a text mentioning a non-punct title 5+ times. "Hadestown" is a
    // safe choice — it's in shows.json and has no trailing punctuation.
    const txt = `
Hadestown remains a milestone for original musicals. Hadestown's revival
shows the songs hold up. Hadestown's design has aged better than most.
Hadestown — hear me out — is a vampire musical of a different kind. Hadestown
proves the form can carry weight. After Hadestown, what comes next?
The Lost Boys never stops moving, kinetic and poetic at once. The Lost Boys
is risk-free I.P., easy to mock. The Lost Boys, like Buffy, swaps camp for
mythology. The Lost Boys cast is excellent. The Lost Boys, the Lost Boys.
`;
    const result = detectMultiShow(txt, 'the-lost-boys-2026');
    const had = result.otherShows.find((s) => /hadestown/i.test(s.title));
    assert.ok(
      had,
      `Expected Hadestown in otherShows. Got: ${JSON.stringify(result.otherShows)}`,
    );
    assert.ok(had.mentions >= 5);
  });

  test('does not match titles inside larger words (no false positives)', async () => {
    const { detectMultiShow } = await import(detectorPath);
    // "Six" appears as a substring of "Sixty" — must not match. (Note: 'six'
    // is also in the SKIP_TITLES set so it's doubly safe; this guards against
    // weakening the boundary check.)
    const txt = `Sixty critics weighed in on this show. Sixty! `.repeat(20);
    const result = detectMultiShow(txt, 'the-lost-boys-2026');
    const six = result.otherShows.find((s) => s.title === 'six');
    assert.strictEqual(six, undefined);
  });
});
