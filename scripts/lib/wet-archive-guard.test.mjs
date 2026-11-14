// BRO-6682: WET archive on an NYC show / pre-run post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wetArchiveProblem, auditWetArchives, showsFromJson } = require('./wet-archive-guard.js');

const nyc = { id: 'in-the-heights-off-broadway-2026', category: 'off-broadway', openingDate: '2026-10-28' };
const bway = { id: 'x-2026', category: 'broadway', openingDate: '2026-03-01' };
const we = { id: 'hello-dolly-west-end-2026', category: 'west-end', openingDate: '2026-07-01' };

test('rejects an archive on an off-Broadway or Broadway show', () => {
  assert.equal(wetArchiveProblem(nyc, { postDate: '2015-02-10' }).code, 'non-london-show');
  assert.equal(wetArchiveProblem(bway, {}).code, 'non-london-show');
});
test('rejects a West End show archive whose post predates the run', () => {
  assert.equal(wetArchiveProblem(we, { postDate: '2023-05-01' }).code, 'post-predates-run');
});
test('accepts a current West End post, incl. early roundup and missing dates', () => {
  assert.equal(wetArchiveProblem(we, { postDate: '2026-07-02' }), null);
  assert.equal(wetArchiveProblem(we, { postDate: '2026-05-15' }), null);
  assert.equal(wetArchiveProblem(we, {}), null);
});
test('auditWetArchives reports only the bad ones', () => {
  const r = auditWetArchives([nyc, we], [
    { showId: nyc.id, archive: { postDate: '2015-02-10', postUrl: 'u' } },
    { showId: we.id, archive: { postDate: '2026-07-02' } },
    { showId: 'gone', archive: {} },
  ]);
  assert.deepEqual(r.map((x) => [x.showId, x.code]), [[nyc.id, 'non-london-show'], ['gone', 'unknown-show']]);
});
test('showsFromJson reads the real shows.json shape ({ _meta, shows })', () => {
  const raw = { _meta: { version: 1 }, shows: [nyc, we] };
  assert.deepEqual(showsFromJson(raw).map((s) => s.id), [nyc.id, we.id]);
  assert.deepEqual(showsFromJson([we]).map((s) => s.id), [we.id]);
  assert.equal(auditWetArchives(showsFromJson(raw), [{ showId: we.id, archive: { postDate: '2026-07-02' } }]).length, 0);
});
