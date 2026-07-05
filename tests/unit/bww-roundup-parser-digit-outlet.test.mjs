/**
 * Unit test for scripts/lib/bww-roundup-parser.js OUTLET regex.
 *
 * Regression: "Matthew Wexler, 1 Minute Critic: ..." was silently dropped
 * because OUTLET required a leading letter. The digit-leading outlet failed
 * to match, AND — because the parser scans for the NEXT match to bound the
 * previous quote — the dropped entry's quote was absorbed into the preceding
 * outlet's quote, corrupting THAT quote too.
 *
 * These tests lock: (a) digit-leading outlets parse, (b) letter-leading
 * outlets still parse, (c) the preceding quote stays clean, (d) known
 * BWW-Roundup shapes (initial-prefix critic name, punctuation between quotes)
 * are unaffected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseArticleBodyReviews } = require('../../scripts/lib/bww-roundup-parser.js');

describe('bww-roundup-parser: digit-leading outlet names', () => {
  test('parses "1 Minute Critic" and does not contaminate previous quote', () => {
    const body =
      "Let's see what the critics had to say! " +
      "Jesse Green, The New York Times: A triumph of staging. " +
      "Matthew Wexler, 1 Minute Critic: Five stars, dazzling. " +
      "Adam Feldman, Time Out: Wonderful.";

    const out = parseArticleBodyReviews(body);
    const outlets = out.map(r => r.outletRaw);
    assert.deepStrictEqual(outlets, ['The New York Times', '1 Minute Critic', 'Time Out']);

    const nyt = out.find(r => r.outletRaw === 'The New York Times');
    assert.strictEqual(nyt.quote, 'A triumph of staging.', 'NYT quote must not absorb the dropped 1MC quote');

    const omc = out.find(r => r.outletRaw === '1 Minute Critic');
    assert.strictEqual(omc.criticName, 'Matthew Wexler');
    assert.strictEqual(omc.quote, 'Five stars, dazzling.');
  });

  test('still parses letter-leading outlets (One Minute Critic variant)', () => {
    const body =
      "Let's see what the critics had to say! " +
      "Sara Holdren, One Minute Critic: A must see. " +
      "Adam Feldman, Time Out: Wonderful.";

    const out = parseArticleBodyReviews(body);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].outletRaw, 'One Minute Critic');
  });

  test('leading-initial critic name still parses ("J. Kelly Nestruck, The Globe and Mail:")', () => {
    // Guards against the earlier feedback_critic_name_initial_truncation regression
    const body =
      "Let's see what the critics had to say! " +
      "J. Kelly Nestruck, The Globe and Mail: A strong revival. " +
      "Jesse Green, The New York Times: Excellent.";

    const out = parseArticleBodyReviews(body);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].criticName, 'J. Kelly Nestruck');
    assert.strictEqual(out[0].outletRaw, 'The Globe and Mail');
  });

  test('OUTLET body still rejects mid-name digits (guard against runaway match)', () => {
    // A stray "5 out of 5" fragment in a quote must not be misread as an outlet.
    // The optional leading-digit prefix only permits digits BEFORE a letter — the
    // body itself is still [A-Za-z\s&'.]+, so "5 out of 5" fails as an outlet.
    const body =
      "Let's see what the critics had to say! " +
      "Jesse Green, The New York Times: Gave it 5 out of 5 in one line. " +
      "Adam Feldman, Time Out: Wonderful.";

    const out = parseArticleBodyReviews(body);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].outletRaw, 'The New York Times');
    assert.strictEqual(out[1].outletRaw, 'Time Out');
  });
});
