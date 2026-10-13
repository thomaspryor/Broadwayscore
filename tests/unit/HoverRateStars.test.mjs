// BRO-77: the hover rate stars must not offer a rating on a show nobody could
// have seen yet (announced, or upcoming before its first preview).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { couldHaveSeenShow } from '../../src/lib/show-rateability.ts';

const TODAY = '2026-10-13';

describe('couldHaveSeenShow', () => {
  test('open, previews and closed shows are rateable', () => {
    for (const status of ['open', 'previews', 'closed']) {
      assert.equal(couldHaveSeenShow({ status, openingDate: '2027-01-01' }, TODAY), true, status);
    }
  });
  test('announced with no dates is not rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'announced' }, TODAY), false);
  });
  test('upcoming with a future first preview is not rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: '2026-11-02', openingDate: '2026-12-01' }, TODAY), false);
  });
  test('upcoming whose first preview is tonight is rateable (status lag)', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: TODAY }, TODAY), true);
  });
  test('upcoming with a past opening date and no preview date is rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: null, openingDate: '2026-10-01' }, TODAY), true);
  });
  test('a full ISO timestamp is compared by its date part', () => {
    assert.equal(couldHaveSeenShow({ status: 'announced', openingDate: '2026-12-01T19:00:00Z' }, TODAY), false);
  });
  test('garbage date on a not-yet-open show stays hidden', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', openingDate: 'TBA' }, TODAY), false);
  });
  test('unknown or missing status falls open', () => {
    assert.equal(couldHaveSeenShow({ status: undefined }, TODAY), true);
    assert.equal(couldHaveSeenShow(null, TODAY), true);
  });
});

// Every call site must hand the component the show, so the gate can run.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every <HoverRateStars> usage passes a show prop', () => {
  const offenders = [];
  let uses = 0;
  for (const file of walk('src')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<HoverRateStars\b([^>]*)\/?>/g)) {
      uses++;
      if (!/\bshow=\{/.test(m[1])) offenders.push(file);
    }
  }
  assert.ok(uses >= 4, `expected the browse + show-page call sites, found ${uses}`);
  assert.deepEqual(offenders, []);
});

test('HoverRateStars checks couldHaveSeenShow before rendering', () => {
  const src = readFileSync('src/components/user/HoverRateStars.tsx', 'utf8');
  assert.match(src, /if \(!couldHaveSeenShow\(show\)\) return null;/);
});
