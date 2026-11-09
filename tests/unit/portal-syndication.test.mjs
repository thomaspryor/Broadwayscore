// BRO-7238 part 2: a Yahoo/MSN/AOL copy defers to ANY other outlet holding the same critic's review of the same show.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const synd = require('../../scripts/lib/syndication-pairs.js');
const { primaryFilesFor } = require('../../scripts/lib/dedup-survivor.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization.js');

test('sameCriticOutletsFrom reads outlets from <outlet>--<critic>[-n].json and anchors the critic slug', () => {
  const files = ['yahoo--jesse-green.json', 'variety--jesse-green.json', 'ap--jesse-green-2.json', 'nytimes--jesse-green-mueller.json', 'x--other.json'];
  assert.deepEqual(synd.sameCriticOutletsFrom(files, 'Jesse Green').sort(), ['ap', 'variety']);
  assert.deepEqual(synd.sameCriticOutletsFrom(['a--rob-weinert-kendt.json'], 'Rob Weinert'), []);
});

test('portal outlet defers to every other same-critic outlet, never to another portal', () => {
  const others = ['variety', 'ap', 'msn', 'yahoo'];
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'yahoo', { sameCriticOutlets: others }).sort(), ['ap', 'thewrap', 'variety']); // thewrap: BRO-7237 group
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'msn', { sameCriticOutlets: others }).sort(), ['ap', 'variety']);
});

test('without sameCriticOutlets (lane callers) the answer is unchanged; non-portals never get the rule', () => {
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'yahoo'), ['thewrap']); // BRO-7237 group only; msn has none
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'msn'), []);
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'variety', { sameCriticOutlets: ['yahoo', 'ap'] }), []);
  assert.deepEqual(synd.getSyndicationPrimaries('Chris Jones', 'nydailynews', { sameCriticOutlets: [] }), ['chicagotribune']);
  assert.deepEqual(synd.getSyndicationPrimaries('Staff', 'yahoo', { sameCriticOutlets: ['variety'] }), []);
});

test('dedup-survivor: a yahoo file defers to the same critic\'s other files only', () => {
  const files = ['yahoo--jesse-green.json', 'variety--jesse-green.json', 'yahoo--someone-else.json'];
  assert.deepEqual(primaryFilesFor('yahoo--jesse-green.json', { criticName: 'Jesse Green', outletKey: 'yahoo' }, files), ['variety--jesse-green.json']);
  assert.deepEqual(primaryFilesFor('yahoo--someone-else.json', { criticName: 'Someone Else', outletKey: 'yahoo' }, files), []);
});

test('explainExclusion drops a portal copy when a live same-critic file exists, keeps it alone', () => {
  const { explainExclusion } = require('../../scripts/lib/review-guards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7238-'));
  const rev = (outletId) => ({ showId: 'test-show-2026', outletId, outlet: outletId, criticName: 'Jesse Green', url: `https://${outletId}.example/r`, publishDate: '2026-11-01', assignedScore: 70, contentTier: 'complete', fullText: 'A full review of the production. '.repeat(40) });
  fs.writeFileSync(path.join(dir, 'yahoo--jesse-green.json'), JSON.stringify(rev('yahoo')));
  const show = { id: 'test-show-2026', title: 'Test Show', openingDate: '2026-11-01', status: 'open' };
  const alone = explainExclusion(rev('yahoo'), show, path.join(dir, 'yahoo--jesse-green.json'));
  assert.notEqual(alone, 'knownSyndicationSecondary');
  fs.writeFileSync(path.join(dir, 'variety--jesse-green.json'), JSON.stringify(rev('variety')));
  assert.equal(explainExclusion(rev('yahoo'), show, path.join(dir, 'yahoo--jesse-green.json')), 'knownSyndicationSecondary');
  assert.notEqual(explainExclusion(rev('variety'), show, path.join(dir, 'variety--jesse-green.json')), 'knownSyndicationSecondary');
});

test('alias portal files (yahoo-news--) never defer to themselves or to each other', () => {
  const files = ['yahoo--jesse-green.json', 'yahoo-news--jesse-green.json'];
  assert.deepEqual(synd.sameCriticOutletsFrom(files, 'Jesse Green', normalizeOutlet), []);
  assert.deepEqual(synd.getSyndicationPrimariesInDir('Jesse Green', 'yahoo', files, normalizeOutlet), ['thewrap']);
  const withVariety = [...files, 'variety--jesse-green.json'];
  assert.deepEqual(synd.getSyndicationPrimariesInDir('Jesse Green', 'yahoo', withVariety, normalizeOutlet).sort(), ['thewrap', 'variety']);
});

test('explainExclusion: a lone yahoo-news file is kept, and with yahoo + yahoo-news side by side neither is dropped', () => {
  const { explainExclusion } = require('../../scripts/lib/review-guards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7238b-'));
  const rev = (outletId) => ({ showId: 'test-show-2026', outletId, outlet: outletId, criticName: 'Jesse Green', url: `https://${outletId}.example/r`, publishDate: '2026-11-01', assignedScore: 70, contentTier: 'complete', fullText: 'A full review of the production. '.repeat(40) });
  const show = { id: 'test-show-2026', title: 'Test Show', openingDate: '2026-11-01', status: 'open' };
  for (const o of ['yahoo-news', 'yahoo']) fs.writeFileSync(path.join(dir, `${o}--jesse-green.json`), JSON.stringify(rev(o)));
  for (const o of ['yahoo-news', 'yahoo']) assert.notEqual(explainExclusion(rev(o), show, path.join(dir, `${o}--jesse-green.json`)), 'knownSyndicationSecondary');
});

test('the rebuild and the exclusion mirror both use the folder-aware helper (class guard: reverting either fails)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts');
  const rebuild = fs.readFileSync(path.join(root, 'rebuild-all-reviews.js'), 'utf8');
  const guards = fs.readFileSync(path.join(root, 'lib', 'review-guards.js'), 'utf8');
  assert.equal((rebuild.match(/getSyndicationPrimariesInDir\(/g) || []).length, 2, 'rebuild skip + inline census');
  assert.doesNotMatch(rebuild, /[^.\w]getSyndicationPrimaries\(\s*criticSynd|[^.\w]getSyndicationPrimaries\(\s*criticLc/);
  assert.match(guards, /getSyndicationPrimariesInDir\(data\.criticName, outletSynd/);
});

test('BRO-7238 part 3: critic-owned repost sites defer to the publisher that ran the review first', () => {
  const cases = [['Tim Teeman', 'timteeman', 'dailybeast'], ['David Cote', 'cote-notices', 'observer'], ['Sarah Monaghan', 'sarahmonaghan', 'allabouttheatreuk'],
    ['Sara Holdren', 'vu', 'vulture'], ['Samuel L. Leiter', 'theatres-leiter-side', 'theater-life'], ['David Sheward', 'thedaviddesk2', 'theater-life']];
  for (const [critic, copy, original] of cases) {
    assert.ok(synd.getSyndicationPrimaries(critic, copy).includes(original), `${copy} should defer to ${original}`);
    assert.ok(!synd.getSyndicationPrimaries(critic, original).includes(copy), `${original} must stay the primary`);
  }
});

test('BRO-7238 part 3 detector: a pair is "covered" once a secondary is known, "unresolved" while both would count', () => {
  const { findSameCriticMultiOutlet, unresolved } = require('../../scripts/lib/same-critic-multi-outlet.js');
  const rows = [
    { showId: 'a', criticName: 'Tim Teeman', outletId: 'dailybeast' }, { showId: 'a', criticName: 'Tim Teeman', outletId: 'timteeman' },
    { showId: 'b', criticName: 'Jesse Green', outletId: 'nytimes' }, { showId: 'b', criticName: 'Jesse Green', outletId: 'theatermania' },
    { showId: 'c', criticName: 'Staff', outletId: 'x' }, { showId: 'c', criticName: 'Staff', outletId: 'y' },
  ];
  const keys = findSameCriticMultiOutlet(rows);
  assert.equal(keys.length, 2);
  assert.deepEqual(unresolved(keys).map((k) => k.showId), ['b']);
});

test('BRO-7238: a portal never defers to unknown/unnamed shadow files, and -2 suffixes count', () => {
  const synd = require('../../scripts/lib/syndication-pairs.js');
  const n = (o) => o;
  assert.deepEqual(synd.sameCriticOutletsFrom(['yahoo--jane-doe.json', 'unknown--jane-doe.json', 'unnamed--jane-doe.json'], 'Jane Doe', n), []);
  assert.deepEqual(synd.sameCriticOutletsFrom(['yahoo--jane-doe.json', 'variety--jane-doe-2.json'], 'Jane Doe', n), ['variety']);
});

test('BRO-7238 class guard: no caller feeds a portal outlet through the plain lookup where a directory is in hand', () => {
  const fs = require('node:fs');
  for (const f of ['scripts/lib/rebuild-staleness-scan.js', 'scripts/lib/press-night-review-state.js', 'scripts/lib/star-score-mismatch.js', 'scripts/lib/dedup-survivor.js']) {
    const src = fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.ok(/getSyndicationPrimariesInDir/.test(src), f + ' must use the folder-aware lookup');
  }
});
