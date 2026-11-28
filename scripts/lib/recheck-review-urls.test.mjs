// BRO-7841: an outlet pulled a review we link (TheaterScene / It's A Wonderful Life, 2026-11-19).
// Class guard: recent review urls are re-tested, a 404/410 withholds the link, the rebuild publishes none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recheck } = require('./recheck-review-urls.js');
const dead = require('./review-url-dead.js');
const NOW = Date.parse('2026-11-19T20:00:00Z');
const GONE = 'https://www.theaterscene.net/plays/broadway-plays/its-a-wonderful-life-a-live-radio-play/samuel-l-leiter/';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7841-'));
  const put = (show, f, rec) => { fs.mkdirSync(path.join(dir, show), { recursive: true }); fs.writeFileSync(path.join(dir, show, f), JSON.stringify(rec)); };
  put('iawl', 'theaterscene--samuel-l-leiter.json', { url: GONE, publishDate: '2026-11-19', outletId: 'theaterscene', criticName: 'Samuel L. Leiter', fullText: 'kept' });
  put('iawl', 'nyt--x.json', { url: 'https://nytimes.com/live', publishDate: '2026-11-19', outletId: 'nyt' });
  put('iawl', 'blocked--x.json', { url: 'https://blocked.example/r', publishDate: '2026-11-19', outletId: 'blocked' });
  put('iawl', 'old--x.json', { url: 'https://old.example/r', publishDate: '2026-10-01', outletId: 'old' });
  return dir;
}
const probeFor = (map) => async (u) => (u in map ? map[u] : 200);
const read = (dir, show, f) => JSON.parse(fs.readFileSync(path.join(dir, show, f), 'utf8'));

test('a url that 404s twice is marked; live, blocked and out-of-window reviews are untouched', async () => {
  const dir = fixture();
  const res = await recheck({ reviewTextsDir: dir, apply: true, now: NOW, hours: 72, probe: probeFor({ [GONE]: 404, 'https://blocked.example/r': 403, 'https://old.example/r': 404 }) });
  assert.equal(res.marked.length, 1);
  const rec = read(dir, 'iawl', 'theaterscene--samuel-l-leiter.json');
  assert.equal(rec.urlDead, true);
  assert.equal(rec.urlDeadUrl, GONE);
  assert.equal(rec.fullText, 'kept'); // text and score stay; only the link is withheld
  assert.equal(read(dir, 'iawl', 'blocked--x.json').urlDead, undefined);
  assert.equal(read(dir, 'iawl', 'old--x.json').urlDead, undefined);
  assert.equal(dead.publishedUrl(rec, null), null);
});

test('one 404 followed by a 200 is not enough', async () => {
  const dir = fixture();
  let n = 0;
  const res = await recheck({ reviewTextsDir: dir, apply: true, now: NOW, hours: 72, probe: async (u) => (u === GONE ? (n++ === 0 ? 404 : 200) : 200) });
  assert.equal(res.marked.length, 0);
});

test('a dry run writes nothing; a republished url restores the link', async () => {
  const dir = fixture();
  await recheck({ reviewTextsDir: dir, apply: false, now: NOW, hours: 72, probe: probeFor({ [GONE]: 410 }) });
  assert.equal(read(dir, 'iawl', 'theaterscene--samuel-l-leiter.json').urlDead, undefined);
  await recheck({ reviewTextsDir: dir, apply: true, now: NOW, hours: 72, probe: probeFor({ [GONE]: 410 }) });
  const res = await recheck({ reviewTextsDir: dir, apply: true, now: NOW + 3600e3, hours: 72, probe: probeFor({}) });
  assert.equal(res.restored.length, 1);
  const rec = read(dir, 'iawl', 'theaterscene--samuel-l-leiter.json');
  assert.equal(rec.urlDead, false); // false, not deleted: the push merge would put a deleted protected field back
  assert.ok(rec.urlRestoredAt);
  assert.equal(dead.publishedUrl(rec, null), GONE);
});

test('a marker for an old url stops applying once the url is repaired', () => {
  const rec = { url: 'https://x.com/new', urlDead: true, urlDeadUrl: 'https://x.com/old' };
  assert.equal(dead.publishedUrl(rec, null), 'https://x.com/new');
});

test('wiring: rebuild publishes through publishedUrl, plans may set the marker, the recheck runs before the rebuild', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const rebuild = fs.readFileSync(path.join(root, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.match(rebuild, /review-url-dead'\)\.publishedUrl\(/);
  const { REVIEW_TEXT_EDITABLE_FIELDS } = require('./review-field-edit.js');
  assert.ok(REVIEW_TEXT_EDITABLE_FIELDS.includes('urlDead'));
  assert.match(fs.readFileSync(path.join(root, 'scripts/lib/review-write-guard.js'), 'utf8'), /'urlDead'/);
  const wf = fs.readFileSync(path.join(root, '.github/workflows/rebuild-reviews.yml'), 'utf8');
  const i = wf.indexOf('recheck-recent-review-urls.js'); const j = wf.indexOf('- name: Rebuild reviews.json');
  assert.ok(i > 0 && i < j, 'recheck step must run before Rebuild reviews.json');
});
