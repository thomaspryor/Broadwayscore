// BRO-5502: u/Boring_Waltz_9545's weekly "Estimated percentage recouped",
// newest per Broadway show, stored on the commercial.json record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  latestRecoupEstimates, analystRecoupPatch, applyAnalystRecoupEstimates, runsNear, newestFigureInRun,
} = require('./waltz-recoup-estimates.js');

// Blocks as the analyst writes them (Week Ending October 11, 2026 post).
const TWO_STRANGERS = [
  '➡***Two Strangers (Carry a Cake Across New York)***\\- *$608k gross, 78% capacity, $93 atp, (Up \\~$104k from last week). Began Performances November 1, 2025, Closing November 29, 2026*',
  '',
  'Gross Less-Fees: $517k; Estimated Weekly Operating Cost: $480k/week; Estimated Profit (Loss): $50k-($50k)',
  '',
  'The holiday did well for Two Strangers, as expected, though their grosses are still fairly low.',
  '',
  'Estimated percentage recouped: 0%',
].join('\n');
const GATSBY = (pct) => [
  '➡ ***The Great Gatsby*** \\- *$1.1 million, 95% capacity, $105 atp (Up \\~$294k from last week). Began performances March 29, 2024, Open-Ended.*',
  '',
  'Gross Less-Fees: $1.037 million; Estimated Weekly Operating Cost: $850k/week; Estimated Profit (Loss): $0k-$100k',
  '',
  `Estimated percentage recouped: ${pct}`,
].join('\n');

const at = (iso) => Date.parse(`${iso}T15:00:00Z`) / 1000;
const post = (iso, selftext, id = iso) => ({ created_utc: at(iso), selftext, permalink: `/r/Broadway/comments/${id}/grosses_analysis/` });

const SHOWS = {
  'two strangers (carry a cake across new york)': { slug: 'two-strangers', previewsStartDate: '2025-11-01', closingDate: '2026-11-29' },
  'the great gatsby': { slug: 'the-great-gatsby', previewsStartDate: '2024-03-29', closingDate: null },
};
const match = (name) => SHOWS[name.toLowerCase()] || null;

test('newest figure per show wins, whatever order the posts arrive in', () => {
  const posts = [post('2026-01-06', GATSBY('20%-40%')), post('2026-10-13', `${GATSBY('10%-30%')}\n\n${TWO_STRANGERS}`)];
  const out = latestRecoupEstimates(posts, match);
  assert.deepEqual(out.get('the-great-gatsby'), {
    pct: [10, 30], asOf: '2026-10-13', url: 'https://www.reddit.com/r/Broadway/comments/2026-10-13/grosses_analysis/', showName: 'The Great Gatsby',
  });
  assert.deepEqual(out.get('two-strangers').pct, [0, 0]);
});

test('a heading with no recouped line, or an unknown show, adds nothing', () => {
  const noLine = GATSBY('').replace(/Estimated percentage recouped: $/m, '');
  assert.equal(latestRecoupEstimates([post('2026-10-13', noLine)], match).size, 0);
  assert.equal(latestRecoupEstimates([post('2026-10-13', TWO_STRANGERS)], () => null).size, 0);
});

test('an older figure for a show stays when the newest post skips its line', () => {
  const posts = [post('2026-09-01', GATSBY('10%-30%')), post('2026-10-13', GATSBY('').replace(/Estimated percentage recouped: $/m, ''))];
  assert.deepEqual(latestRecoupEstimates(posts, match).get('the-great-gatsby').asOf, '2026-09-01');
});

test('a production that was not running near the post never takes the figure', () => {
  // A same-title revival that starts years later, and one that closed long before.
  assert.equal(runsNear({ previewsStartDate: '2028-03-01' }, '2026-10-13'), false);
  assert.equal(runsNear({ previewsStartDate: '2024-03-29', closingDate: '2025-01-05' }, '2026-10-13'), false);
  assert.equal(runsNear({ previewsStartDate: '2026-11-20' }, '2026-10-13'), true); // starts within 45 days
  assert.equal(runsNear({ previewsStartDate: '2024-03-29', closingDate: '2026-08-01' }, '2026-10-13'), true); // post-mortem window
  const future = (name) => (match(name) ? { slug: 'the-great-gatsby-2030', previewsStartDate: '2030-01-01' } : null);
  assert.equal(latestRecoupEstimates([post('2026-10-13', GATSBY('10%-30%'))], future).size, 0);
});

test('a late recap or an earlier production does not hide his figure from the run', () => {
  const show = { previewsStartDate: '2024-09-01', closingDate: '2025-01-05' };
  const recap = { postDate: '2025-09-30', cost: 700000 }; // 268 days after closing
  const inRun = { postDate: '2024-12-10', cost: 650000 };
  const tooEarly = { postDate: '2024-03-01', cost: 900000 }; // an earlier production of the title
  assert.equal(newestFigureInRun(show, [recap, inRun, tooEarly]), inRun);
  assert.equal(newestFigureInRun(show, [inRun, recap]), inRun);
  assert.equal(newestFigureInRun(show, [recap, tooEarly]), undefined);
  assert.equal(newestFigureInRun({}, [recap]), recap); // no dates on file: nothing to check against
});

test('implausible figures are dropped, a reversed range is put in order', () => {
  assert.equal(latestRecoupEstimates([post('2026-10-13', GATSBY('900%'))], match).size, 0);
  assert.deepEqual(latestRecoupEstimates([post('2026-10-13', GATSBY('30%-10%'))], match).get('the-great-gatsby').pct, [10, 30]);
});

test('patch: only a newer post replaces the stored figure, and only the three analyst fields', () => {
  const est = { pct: [10, 30], asOf: '2026-10-13', url: 'https://www.reddit.com/x', showName: 'The Great Gatsby' };
  assert.equal(analystRecoupPatch({ analystRecoupAsOf: '2026-10-13', analystRecoupPct: [10, 30], analystRecoupUrl: 'https://www.reddit.com/x' }, est), null);
  assert.equal(analystRecoupPatch({ analystRecoupAsOf: '2026-11-01' }, est), null);
  // The same post, edited: its corrected figure replaces the earlier reading.
  assert.deepEqual(analystRecoupPatch({ analystRecoupAsOf: '2026-10-13', analystRecoupPct: [20, 40], analystRecoupUrl: 'https://www.reddit.com/x' }, est).analystRecoupPct, [10, 30]);
  assert.deepEqual(analystRecoupPatch({ recouped: false, analystRecoupAsOf: '2026-10-06' }, est), {
    analystRecoupPct: [10, 30], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://www.reddit.com/x',
  });
  assert.equal(analystRecoupPatch(null, est), null);
});

test('apply: writes onto existing records only, and a dry run changes nothing', () => {
  const posts = [post('2026-10-13', `${GATSBY('10%-30%')}\n\n${TWO_STRANGERS}`)];
  const records = { 'the-great-gatsby': { recouped: false, designation: 'TBD' } };
  const dry = applyAnalystRecoupEstimates(records, posts, match, { apply: false });
  assert.deepEqual(dry.noRecord, ['two-strangers']);
  assert.equal(dry.updated.length, 1);
  assert.equal(records['the-great-gatsby'].analystRecoupPct, undefined);
  const wet = applyAnalystRecoupEstimates(records, posts, match);
  assert.deepEqual(records['the-great-gatsby'], {
    recouped: false, designation: 'TBD',
    analystRecoupPct: [10, 30], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://www.reddit.com/r/Broadway/comments/2026-10-13/grosses_analysis/',
  });
  assert.deepEqual(wet.updated, [{ slug: 'the-great-gatsby', from: null, to: [10, 30], asOf: '2026-10-13' }]);
  // Second run with the same posts: nothing to do.
  assert.equal(applyAnalystRecoupEstimates(records, posts, match).updated.length, 0);
});
