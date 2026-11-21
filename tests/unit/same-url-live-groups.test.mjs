// BRO-5858: one article url held by two live review files in one show.
//
// Reproduces a-beautiful-noise-the-neil-diamond-musical-2022 (2026-09-27):
// show-not-mentioned recovery moved vulture--sara-holdren.json onto Jackson
// McHenry's review url. The sibling-ownership guard compared urls with
// sameUrlKey, which keeps ?utm_* params, so McHenry's file (stored with
// ?utm_medium=s1&utm_source=tw...) did not count as "this url's owner".

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { sameArticleUrl, findSiblingUrlOwner } = require(path.join(REPO, 'scripts/lib/review-url-collision.js'));
const { urlOwnedByOtherCritic, urlHeldBySibling } = require(path.join(REPO, 'scripts/lib/review-slot-guards.js'));
const { updateFileUrlWithInvariant } = require(path.join(REPO, 'scripts/lib/url-change-invariant.js'));
const { isLiveForSameUrl, findShowSameUrlLiveGroups, findSameUrlLiveGroups, bylineMentions } =
  require(path.join(REPO, 'scripts/lib/same-url-live-groups.js'));

const BARE = 'https://www.vulture.com/2022/12/theater-review-a-beautiful-noise-broadway-neil-diamond-musical.html';
const TRACKED = `${BARE}?utm_medium=s1&utm_source=tw&utm_campaign=vulture`;

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function showDir(files, name = 'a-beautiful-noise-the-neil-diamond-musical-2022') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5858-'));
  roots.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(data, null, 2));
  return dir;
}

const mchenry = { showId: 'a-beautiful-noise-the-neil-diamond-musical-2022', outletId: 'vulture', criticName: 'Jackson McHenry', url: TRACKED, contentTier: 'complete' };
const holdren = { showId: 'a-beautiful-noise-the-neil-diamond-musical-2022', outletId: 'vulture', criticName: 'Sara Holdren', url: 'https://www.vulture.com/2022/12/theater-review-a-beautiful-noise-the-neil-diamond-musical.html', contentTier: 'complete' };

test('sameArticleUrl folds tracking params, www and protocol but keeps real query ids', () => {
  assert.equal(sameArticleUrl(TRACKED, BARE), true);
  assert.equal(sameArticleUrl('http://vulture.com/2022/12/x.html/', 'https://www.vulture.com/2022/12/x.html'), true);
  assert.equal(sameArticleUrl('https://site.com/?p=123', 'https://site.com/?p=124'), false);
  assert.equal(sameArticleUrl('https://site.com/a', 'https://site.com/b'), false);
  assert.equal(sameArticleUrl(null, BARE), false);
});

test('urlOwnedByOtherCritic sees the owner through a utm-tagged url (the BRO-5858 miss)', () => {
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry, 'vulture--sara-holdren.json': holdren });
  const owner = urlOwnedByOtherCritic({ showDir: dir, url: BARE, selfFilename: 'vulture--sara-holdren.json', selfCriticName: 'Sara Holdren' });
  assert.deepEqual(owner, { filename: 'vulture--jackson-mchenry.json', criticName: 'Jackson McHenry' });
});

test('updateFileUrlWithInvariant refuses to move one critic onto another critic\'s tracked url', () => {
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry, 'vulture--sara-holdren.json': holdren });
  const file = path.join(dir, 'vulture--sara-holdren.json');
  const res = updateFileUrlWithInvariant(file, BARE, { urlDiscoveryMethod: 'show-not-mentioned-recovery' }, { stampOnNoop: true, oldUrlProvenWrong: true });
  assert.equal(res, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).url, holdren.url);
});

test('urlHeldBySibling (raw SERP writers) refuses a held url even when a byline is Unknown', () => {
  const unknown = { ...holdren, criticName: 'Unknown' };
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry, 'vulture--unknown.json': unknown });
  // the critic-identity guard lets an Unknown self through; the raw-write guard must not
  assert.equal(urlOwnedByOtherCritic({ showDir: dir, url: BARE, selfFilename: 'vulture--unknown.json', selfCriticName: 'Unknown' }), null);
  assert.deepEqual(urlHeldBySibling({ showDir: dir, url: BARE, selfFilename: 'vulture--unknown.json' }),
    { filename: 'vulture--jackson-mchenry.json', criticName: 'Jackson McHenry' });
  // its own url is not "held by a sibling"; a duplicateOf sibling holds nothing
  assert.equal(urlHeldBySibling({ showDir: dir, url: BARE, selfFilename: 'vulture--jackson-mchenry.json' }), null);
  fs.writeFileSync(path.join(dir, 'vulture--jackson-mchenry.json'), JSON.stringify({ ...mchenry, duplicateOf: 'x.json' }));
  assert.equal(urlHeldBySibling({ showDir: dir, url: BARE, selfFilename: 'vulture--unknown.json' }), null);
});

test('findSiblingUrlOwner matches a tracked variant of the candidate url', () => {
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry });
  const owner = findSiblingUrlOwner({ showDir: dir, url: BARE, selfFilename: 'vulture--sara-holdren.json' });
  assert.equal(owner && owner.filename, 'vulture--jackson-mchenry.json');
});

test('isLiveForSameUrl follows the card definition', () => {
  assert.equal(isLiveForSameUrl({ contentTier: 'complete' }), true);
  assert.equal(isLiveForSameUrl({ contentTier: 'excerpt', duplicateTextOf: 'x.json' }), true);
  assert.equal(isLiveForSameUrl({ contentTier: 'stub' }), false);
  assert.equal(isLiveForSameUrl({ contentTier: 'complete', duplicateOf: 'x.json' }), false);
  assert.equal(isLiveForSameUrl({ contentTier: 'complete', wrongProduction: true }), false);
  assert.equal(isLiveForSameUrl({ contentTier: 'complete', rejectedAt: '2026-01-01' }), false);
  assert.equal(isLiveForSameUrl({ contentTier: 'complete', isRoundupArticle: true }), false);
  assert.equal(isLiveForSameUrl({ contentTier: 'complete', wrongAttribution: true }), false);
});

test('findShowSameUrlLiveGroups groups by article key and drops duplicateOf losers', () => {
  const moved = { ...holdren, url: BARE, duplicateTextOf: 'vulture--jackson-mchenry.json' };
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry, 'vulture--sara-holdren.json': moved });
  const groups = findShowSameUrlLiveGroups(dir);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.file), ['vulture--jackson-mchenry.json', 'vulture--sara-holdren.json']);

  fs.writeFileSync(path.join(dir, 'vulture--sara-holdren.json'), JSON.stringify({ ...moved, duplicateOf: 'vulture--jackson-mchenry.json' }));
  assert.equal(findShowSameUrlLiveGroups(dir).length, 0);
});

test('findSameUrlLiveGroups honors the allowlist', () => {
  const moved = { ...holdren, url: BARE };
  const dir = showDir({ 'vulture--jackson-mchenry.json': mchenry, 'vulture--sara-holdren.json': moved });
  const root = path.dirname(dir);
  const { groups } = findSameUrlLiveGroups(root);
  assert.equal(groups.length, 1);
  const allowlist = { [`${groups[0].showId}|${groups[0].key}`]: { reason: 'test' } };
  const res = findSameUrlLiveGroups(root, { allowlist });
  assert.equal(res.groups.length, 0);
  assert.equal(res.allowlisted.length, 1);
});

test('bylineMentions counts each candidate name, accent-folded', () => {
  const m = bylineMentions('By Jackson McHenry. ... Nilgün Yusuf ... jackson mchenry', ['Jackson McHenry', 'Sara Holdren', 'Nilgun Yusuf', 'Unknown']);
  assert.deepEqual(m, { 'Jackson McHenry': 2, 'Sara Holdren': 0, 'Nilgun Yusuf': 1, Unknown: 0 });
});
