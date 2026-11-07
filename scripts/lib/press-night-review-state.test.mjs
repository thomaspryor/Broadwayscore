import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('./press-night-review-state.js');

const SHOW = { id: 'x-2026', title: 'X', openingDate: '2026-10-22', category: 'broadway' };

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnrs-'));
  fs.mkdirSync(path.join(dir, 'x-2026'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'x-2026', name), JSON.stringify(body));
  return dir;
}

test('readReviewFileState: no review-texts dir is unavailable, never "nothing excluded"', () => {
  const r = state.readReviewFileState('x-2026', SHOW, { dir: path.join(os.tmpdir(), 'pnrs-does-not-exist') });
  assert.equal(r.available, false);
  assert.deepEqual(r.files, []);
});

test('readReviewFileState: uses the rebuild predicate (wrongProduction and wrongShow are excluded)', () => {
  const dir = dirWith({
    'nytimes--a.json': { outletId: 'nytimes', outlet: 'The New York Times', criticName: 'A', publishDate: '2026-10-22', firstSeenAt: '2026-10-23T02:30:00Z', fullText: 'x'.repeat(2000) },
    'cititour--b.json': { outletId: 'cititour', outlet: 'Cititour', criticName: 'B', publishDate: '2025-06-02', firstSeenAt: '2026-08-14T00:00:00Z', wrongProduction: true },
    'vulture--c.json': { outletId: 'vulture', outlet: 'Vulture', criticName: 'C', publishDate: '2026-10-22', firstSeenAt: '2026-10-23T04:01:00Z', wrongShow: true },
  });
  const { files } = state.readReviewFileState('x-2026', SHOW, { dir });
  const by = Object.fromEntries(files.map((f) => [f.outletId, f]));
  assert.equal(by.nytimes.includable, true);
  assert.equal(by.cititour.includable, false);
  assert.equal(by.cititour.reason, 'wrongProduction');
  assert.equal(by.vulture.includable, false);
});

test('censusExclusions: an outlet whose every file is excluded leaves the census; one includable file keeps it', () => {
  const census = { entries: [{ outletId: 'cititour' }, { outletId: 'nytimes' }, { outletId: 'deadline' }, { outletId: 'nydailynews' }] };
  const files = [
    { outletId: 'cititour', includable: false, reason: 'wrongProduction' },
    { outletId: 'nytimes', includable: false, reason: 'nonReview' },
    { outletId: 'nytimes', includable: true, reason: null },
    { outletId: 'nydailynews', includable: false, reason: 'knownSyndicationSecondary', syndicatedUnder: 'chicagotribune' },
  ];
  const ex = state.censusExclusions(census, files);
  assert.deepEqual(ex.map((e) => e.outletId).sort(), ['cititour', 'nydailynews']);
  assert.match(ex.find((e) => e.outletId === 'nydailynews').reason, /syndicated copy of the chicagotribune review/);
  assert.equal(ex.find((e) => e.outletId === 'cititour').reason, 'wrongProduction');
  // deadline has no file at all (a listing we have not ingested): it stays in the denominator
  assert.ok(!ex.some((e) => e.outletId === 'deadline'));
});
