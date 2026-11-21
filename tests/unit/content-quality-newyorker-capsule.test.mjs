/**
 * BRO-7171: New Yorker "Goings On About Town" listing capsules were labelled
 * truncated. A capsule is a whole review of roughly 100-250 words that ends
 * with the venue/dates line and "Published in the print edition of ...";
 * Path 3 rejected them only because their prose misses hasOpinionLanguage()'s
 * vocabulary (hand check, 2026-11-09: 19 stored rows, e.g. grey-house-2023,
 * the-kite-runner-2022, cost-of-living-2022). The capsule head in the text
 * (section label, title, "By <critic>", date) now stands in for that proxy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyContentTier, isNewYorkerCapsule } = require('../../scripts/lib/content-quality.js');

// Real capsule text (the-kite-runner-2022, stored via serp-text-recovery).
const KITE_RUNNER = 'The Theatre The Kite Runner By Elisabeth Vincentelli July 29, 2022 The Afghan American novelist Khaled Hosseini’s best-selling début, published in 2003, is a sprawling yarn spanning decades and continents, with a narrative engine fuelled by betrayal and guilt. Turning “The Kite Runner” into a play must have been a challenging endeavor, but this new Broadway production does well, for the most part, by the source material, even if it can be frustratingly earthbound. Matthew Spangler’s adaptation, directed by Giles Croft, tracks the physical and emotional journey of Amir (Amir Arison, in a marathon role), an Afghan refugee in the United States who is haunted by the fact that he deserted his best friend, Hassan (Eric Sirakian), at a time of great need. The first act is sustained by efficient storytelling; the downgrading of the character Assef (Amir Malaklou), however, from the sociopath he was in the book to a garden-variety bully, is indicative of a general timidity on the production’s part. (Hayes Theatre; through Oct. 30.) Published in the print edition of the August 8, 2022 , issue.';

function rec(fullText, outletId = 'newyorker') {
  return { outletId, fullText, url: 'https://www.newyorker.com/goings-on-about-town/theatre/the-kite-runner-08-08-22' };
}

test('a whole New Yorker listing capsule is complete', () => {
  const t = classifyContentTier(rec(KITE_RUNNER));
  assert.equal(t.contentTier, 'complete');
  assert.equal(t.tierReason, 'New Yorker listing capsule');
});

test('the capsule head is found behind glued page chrome', () => {
  assert.equal(isNewYorkerCapsule('SearchSearchOpen Navigation MenuMenuNow PlayingNext to NormalBy The New YorkerMarch 16, 2009This musical...'), true);
});

test('the same capsule cut mid-sentence stays truncated', () => {
  const cut = KITE_RUNNER.slice(0, KITE_RUNNER.indexOf('from the sociopath'));
  assert.equal(classifyContentTier(rec(cut)).contentTier, 'truncated');
});

test('an Openings and Previews blurb is not a capsule review', () => {
  const blurb = 'Openings and Previews Sojourners By The New Yorker January 21, 2016 In Mfoniso Udofia’s play, directed by Ed Sylvanus Iskandar, a Nigerian immigrant longs to return to Africa. In previews. Opens Jan. 28.';
  assert.equal(isNewYorkerCapsule(blurb), false);
});

test('the relaxation is New Yorker only', () => {
  assert.equal(classifyContentTier(rec(KITE_RUNNER, 'timeout')).tierReason === 'New Yorker listing capsule', false);
});
