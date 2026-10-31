import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const holds = require('../../scripts/lib/shouted-title-holds.js');
const { weShoutedHolds } = require('../../scripts/report-shouted-title-holds.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'holds-'));
const cand = { title: 'HAMILTON', venue: 'Victoria Palace', source: 'discover:wet' };

test('a held candidate is saved and listed, not just logged', () => {
  const file = path.join(tmp(), 'holds.json');
  holds.save(holds.recordHolds(holds.load(file), [cand], new Date('2026-10-01T00:00:00Z')), file);
  const list = holds.listHolds(holds.load(file));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'HAMILTON');
  assert.equal(list[0].discoveredAt, '2026-10-01T00:00:00.000Z');
});

test('seeing the same hold again keeps discoveredAt and counts the sighting', () => {
  let s = holds.recordHolds({ holds: {} }, [cand], new Date('2026-10-01T00:00:00Z'));
  s = holds.recordHolds(s, [{ ...cand, venue: 'victoria palace' }], new Date('2026-10-05T00:00:00Z'));
  const [h] = holds.listHolds(s);
  assert.equal(holds.listHolds(s).length, 1);
  assert.equal(h.discoveredAt, '2026-10-01T00:00:00.000Z');
  assert.equal(h.lastSeenAt, '2026-10-05T00:00:00.000Z');
  assert.equal(h.seenCount, 2);
});

test('a resolved hold is removed without touching the others', () => {
  const s = holds.recordHolds({ holds: {} }, [cand, { title: 'WICKED', venue: 'Apollo' }]);
  const [first] = holds.listHolds(s);
  const r = holds.resolveHold(s, first.hash);
  assert.equal(r.removed, true);
  assert.equal(holds.listHolds(r.store).length, 1);
  assert.equal(holds.resolveHold(r.store, 'nope').removed, false);
});

test('West End promoter shouted-title rejections are reported alongside', () => {
  const file = path.join(tmp(), 'we.json');
  fs.writeFileSync(file, JSON.stringify({ rejected: {
    aaa: { kind: 'skip-shouted-title', title: 'CATS', venue: 'X', firstSeen: '2026-10-02T00:00:00Z' },
    bbb: { kind: 'skip-venue', title: 'Other', venue: 'Y', firstSeen: '2026-10-02T00:00:00Z' },
  } }));
  const out = weShoutedHolds(file);
  assert.deepEqual(out.map((h) => h.title), ['CATS']);
});

test('discover-new-shows persists its holds through the shared module', () => {
  const src = fs.readFileSync(new URL('../../scripts/discover-new-shows.js', import.meta.url), 'utf8');
  assert.match(src, /shouted-title-holds/);
  assert.match(src, /recordHolds\(holds\.load\(\), heldForTitleReview\)/);
});
