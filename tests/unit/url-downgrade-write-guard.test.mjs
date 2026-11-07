/**
 * BRO-3781 (#1416 class): safeWriteReview is the one chokepoint every url swap
 * passes through, so it refuses a swap onto a prior-production (dated outside
 * the show's run) or Talkin' Broadway forum-thread url, whichever producer
 * proposed it, and rolls back the fields that arrived paired with that url.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');

const SHOW_ID = 'some-revival-2026';
const SHOW = {
  id: SHOW_ID, title: 'Some Revival', category: 'broadway', market: 'broadway',
  previewsStartDate: '2026-02-01', openingDate: '2026-03-01',
};
const CURRENT = 'https://www.nytimes.com/2026/03/02/theater/some-revival-review.html';
const PRIOR = 'https://www.nytimes.com/2014/12/15/theater/some-revival-review.html';
const OTHER_CURRENT = 'https://www.nytimes.com/2026/03/03/theater/some-revival-broadway-review.html';
const TB_PAGE = 'https://www.talkinbroadway.com/page/ob/03_02_26.html';
const TB_FORUM = 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=12345';

function setup(extra) {
  _setShowsCacheForTest(new Map([[SHOW_ID, SHOW]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3781-'));
  const showDir = path.join(dir, SHOW_ID);
  fs.mkdirSync(showDir);
  const file = path.join(showDir, 'nytimes--jane-doe.json');
  const rec = {
    showId: SHOW_ID, outletId: 'nytimes', outlet: 'The New York Times',
    criticName: 'Jane Doe', url: CURRENT, ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return { file, rec };
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

afterEach(() => _setShowsCacheForTest(null));

describe('safeWriteReview url-downgrade chokepoint (BRO-3781)', () => {
  test('refuses a swap to a prior-production url and drops its paired score', () => {
    const { file, rec } = setup({});
    safeWriteReview(file, { ...rec, url: PRIOR, originalScore: '5/5', dtliExcerpt: 'old production praise' }, {});
    const out = read(file);
    assert.equal(out.url, CURRENT);
    assert.equal(out.originalScore, undefined);
    assert.equal(out.dtliExcerpt, undefined);
  });

  test('a refused swap leaves no swap bookkeeping behind', () => {
    const { file, rec } = setup({});
    safeWriteReview(file, { ...rec, url: PRIOR, urlCorrectedFrom: CURRENT, urlCorrectedReason: 'serp', needsRefetch: true }, {});
    const out = read(file);
    assert.equal(out.url, CURRENT);
    assert.equal(out.urlCorrectedFrom, undefined);
    assert.equal(out.needsRefetch, undefined);
  });

  test('refuses a swap from a real TB review page to a forum thread', () => {
    const { file, rec } = setup({ url: TB_PAGE, outletId: 'talkinbroadway' });
    safeWriteReview(file, { ...rec, url: TB_FORUM }, {});
    assert.equal(read(file).url, TB_PAGE);
  });

  test('allows a swap between two in-window urls', () => {
    const { file, rec } = setup({});
    safeWriteReview(file, { ...rec, url: OTHER_CURRENT }, {});
    assert.equal(read(file).url, OTHER_CURRENT);
  });

  test('allows repairing a prior-production url to an in-window one', () => {
    const { file, rec } = setup({ url: PRIOR });
    safeWriteReview(file, { ...rec, url: CURRENT }, {});
    assert.equal(read(file).url, CURRENT);
  });

  test('force and an approved url repair still win', () => {
    const a = setup({});
    safeWriteReview(a.file, { ...a.rec, url: PRIOR }, { force: true });
    assert.equal(read(a.file).url, PRIOR);
    const b = setup({});
    safeWriteReview(b.file, { ...b.rec, url: PRIOR }, { approvedUrlRepair: true });
    assert.equal(read(b.file).url, PRIOR);
  });

  test('unknown show fails open', () => {
    const { file, rec } = setup({});
    _setShowsCacheForTest(new Map());
    safeWriteReview(file, { ...rec, url: PRIOR }, {});
    assert.equal(read(file).url, PRIOR);
  });
});
