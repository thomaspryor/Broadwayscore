// BRO-7750: owner-approved per-show score gate overrides (data/score-gate-overrides.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewsRemainingForScore, hasEnoughReviews } = require('../../scripts/lib/min-reviews.js');
const { scoreGateArg, isCuratedHistoricalShow } = require('../../scripts/lib/should-hide-reviews.js');
const overrides = require('../../data/score-gate-overrides.json');

test('numeric override replaces the market minimum and the T3-only extra', () => {
  assert.equal(reviewsRemainingForScore(3, 'broadway', 1, 3), 0);
  assert.equal(reviewsRemainingForScore(2, 'broadway', 1, 3), 1);
  assert.equal(reviewsRemainingForScore(3, 'broadway', 0, 3), 0);
  assert.equal(hasEnoughReviews(3, 'broadway', 1, 3), true);
});

test('booleans keep the old behaviour', () => {
  assert.equal(reviewsRemainingForScore(3, 'broadway', 1, false), 2);
  assert.equal(reviewsRemainingForScore(4, 'broadway', 1, true), 0);
  assert.equal(reviewsRemainingForScore(3, 'broadway', 1, undefined), 2);
  assert.equal(reviewsRemainingForScore(3, 'broadway', 0, 0), 4, 'zero is not an override');
});

test('scoreGateArg reads the overrides file, else curated status', () => {
  assert.equal(scoreGateArg('blue-man-group-a-new-holiday-surprise-2026'), 3);
  assert.equal(scoreGateArg('hamilton-2015'), false);
  assert.equal(scoreGateArg('9-to-5-2009'), isCuratedHistoricalShow('9-to-5-2009'));
  assert.equal(scoreGateArg(''), false);
});

test('every override is owner-approved, sane and names a real show id shape', () => {
  for (const [id, o] of Object.entries(overrides.shows)) {
    assert.match(id, /^[a-z0-9-]+-\d{4}$/);
    assert.ok(Number.isInteger(o.minReviews) && o.minReviews >= 2 && o.minReviews <= 5, `${id} minReviews`);
    assert.match(o.approvedBy || '', /owner/i, `${id} needs approvedBy naming the owner`);
    assert.ok((o.reason || '').length > 5, `${id} needs a reason`);
  }
});

// The site (src/config/scoring.ts) and the scripts (should-hide-reviews.js) each
// carry a scoreGateArg. If they drift, the page and the app/feeds disagree on
// whether a show has a score. Run the real TS through tsx; no silent skip.
test('TS scoreGateArg (site) agrees with the JS copy (scripts) for every override and sample shows', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const curated = require('../../data/curated-historical-shows.json');
  const ids = [...Object.keys(overrides.shows), curated[0], 'hamilton-2015', 'no-such-show', '', null];
  const src = `import { scoreGateArg } from ${JSON.stringify(path.join(root, 'src/config/scoring.ts'))};
    process.stdout.write(JSON.stringify(${JSON.stringify(ids)}.map((id) => scoreGateArg(id))));`;
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', src], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ids.map((id) => scoreGateArg(id)));
});
