/**
 * BRO-7272 class guard: a complete review followed by page-footer chrome whose last
 * characters look like a cut-off ("..." teaser, "Like Loading...", stacked ads) must
 * still assess as complete. Fails if the footer anchors in text-quality.js are removed.
 * Synthetic prose only (no review text).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { assessFullText } = require('./text-quality.js');

const BODY = 'The staging is spare and the cast is superb. '.repeat(30) +
  'The final scene lands with real force, and the evening ends on a quiet, devastating note.';

const FOOTERS = {
  nypost: " Read More Filed under broadway plays theater reviews 11/9/26 Read Next 'Another' review: A long teaser headline goes off ...",
  wordpress: ' Share this: Click to share on X (Opens in new window) X Click to email a link to a friend (Opens in new window) Email Print (Opens in new window) Print Like Loading...',
  nytimesRibbon: ' +Give this article+Advertisement',
  stackedAds: ' Advertisement Advertisement Advertisement',
};

for (const [name, footer] of Object.entries(FOOTERS)) {
  test(`complete review + ${name} footer is complete`, () => {
    assert.strictEqual(assessFullText(BODY + footer, true, { trustedComplete: true }), 'complete');
  });
}

test('a genuinely cut-off body still reads truncated', () => {
  const cut = BODY.slice(0, BODY.length - 40) + ' and the evening ends on a qu...';
  assert.strictEqual(assessFullText(cut, true, { trustedComplete: true }), 'truncated');
});

// Ship-check finding: the same widgets also sit at the TOP of a page, under the subhead. They must never cut the body.
const { stripTrailingJunk } = require('./text-quality.js');
const HEADERS = {
  nytimesRibbon: 'A revival of a lifesaving play.\n\nShare full article+',
  shareBar: 'A revival of a lifesaving play. Share this: Share on X (Opens in new window) X Share on Facebook (Opens in new window) ',
};
for (const [name, header] of Object.entries(HEADERS)) {
  test(`${name} at the top of the page keeps the whole review body`, () => {
    const out = stripTrailingJunk(header + BODY);
    assert.ok(out.includes('ends on a quiet, devastating note.'), 'body survived');
  });
}

test('sharing bar whose button names were already removed still cuts as a footer', () => {
  const out = stripTrailingJunk(BODY + ' Share this: (Opens in new window)');
  assert.ok(out.endsWith('devastating note.'), out.slice(-60));
});

// Related-interviews list footer (readaboutstuff): must cut as footer, genuine cutoff stays truncated.
{
  const { stripTrailingJunk: strip2, assessFullText: assess2 } = require('./text-quality.js');
  const body = 'A warm, funny evening that earns its laughs. '.repeat(30) + 'Rating: 2 out of 5.';
  const list = " Interview: Ann Lee discusses 'Almost, Maine' Interview: Bo Kim discusses 'Hourglass' Interview: Cy Roe discusses 'Dust' Interview: Di Fay discusses 'SUCCUBUS'";
  test('related-interviews list footer is cut and the review reads complete', () => {
    assert.ok(!/Interview:/.test(strip2(body + list)));
    assert.strictEqual(assess2(body + list), 'complete');
  });
}

// A closing "Tickets available at <url>" line is a clean ending; a cut-off sentence is not.
{
  const { endsProperlyWithPunctuation } = require('./text-quality.js');
  test('closing ticket link counts as a proper ending', () => {
    assert.ok(endsProperlyWithPunctuation('Runs to 7 November. Tickets available at https://example.org/productions/x/'));
  });
  test('a sentence cut off before a link still fails', () => {
    assert.ok(!endsProperlyWithPunctuation('The second act loses its way and the closing scene never'));
    assert.ok(!endsProperlyWithPunctuation('See https://example.org/x for the bit that follows and then'));
  });
}

// Whole-file: a review that ends with a ticket link assesses complete; one cut off after a link does not.
{
  const { assessFullText: assess3 } = require('./text-quality.js');
  const prose = 'A warm, funny evening that earns its laughs and a cast that commits fully. '.repeat(12);
  test('review ending in a ticket link assesses complete', () => {
    assert.strictEqual(assess3(prose + 'Runs to 7 November. Tickets available at https://example.org/productions/x/'), 'complete');
  });
  test('review cut off after a mid-text link stays truncated', () => {
    assert.strictEqual(assess3(prose + 'See https://example.org/x for the rest and then the cast leave the stage'), 'truncated');
  });
}
