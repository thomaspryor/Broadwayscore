// BRO-5243: critic tenure at an outlet. Teachout's WSJ reviews (2017-2021) were
// credited to Isherwood, who became WSJ's critic only after Teachout died.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateTemporalAttribution } = require('../../scripts/lib/temporal-byline-guard.js');

test('Isherwood at WSJ before his tenure is blocked; after it, and at other outlets, is fine', () => {
  const r = validateTemporalAttribution('Charles Isherwood', 'November 28, 2019', 'wsj');
  assert.equal(r.ok, false);
  assert.equal(r.hardBlock, true);
  assert.match(r.reason, /joined wsj on 2022-01-14/);
  assert.equal(validateTemporalAttribution('Charles Isherwood', '2023-04-21', 'wsj').ok, true);
  assert.equal(validateTemporalAttribution('Charles Isherwood', '2010-05-01', 'nytimes').ok, true);
  assert.equal(validateTemporalAttribution('Charles Isherwood', '2019-11-28').ok, true, 'no outlet, no tenure check');
});

test('the retired-critic rule is unchanged', () => {
  assert.equal(validateTemporalAttribution('Terry Teachout', '2022-03-01', 'wsj').hardBlock, true);
  assert.equal(validateTemporalAttribution('Terry Teachout', '2019-11-28', 'wsj').ok, true);
});

test('safeWriteReview credits a pre-tenure WSJ Isherwood row to Unknown, whatever the outlet alias', () => {
  const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenure-'));
  try {
    for (const [file, outletId] of [['wsj--charles-isherwood.json', 'wsj'], ['wall-street-journal--charles-isherwood.json', undefined]]) {
      const fp = path.join(dir, 'a-show-2019', file);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      safeWriteReview(fp, { showId: 'a-show-2019', outletId, outlet: 'The Wall Street Journal', criticName: 'Charles Isherwood', url: `https://www.wsj.com/articles/x-${file}`, publishDate: '2019-11-28' });
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      assert.equal(d.criticName, 'Unknown', file);
      assert.match(d._temporalGuardBlocked, /joined wsj/);
    }
    const ok = path.join(dir, 'b-show-2023', 'wsj--charles-isherwood.json');
    fs.mkdirSync(path.dirname(ok), { recursive: true });
    safeWriteReview(ok, { showId: 'b-show-2023', outletId: 'wsj', criticName: 'Charles Isherwood', url: 'https://www.wsj.com/articles/y', publishDate: '2023-04-21' });
    assert.equal(JSON.parse(fs.readFileSync(ok, 'utf8')).criticName, 'Charles Isherwood');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
