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

test('sameCriticOutletsFrom reads outlets from <outlet>--<critic>[-n].json and anchors the critic slug', () => {
  const files = ['yahoo--jesse-green.json', 'variety--jesse-green.json', 'ap--jesse-green-2.json', 'nytimes--jesse-green-mueller.json', 'x--other.json'];
  assert.deepEqual(synd.sameCriticOutletsFrom(files, 'Jesse Green').sort(), ['ap', 'variety', 'yahoo']);
  assert.deepEqual(synd.sameCriticOutletsFrom(['a--rob-weinert-kendt.json'], 'Rob Weinert'), []);
});

test('portal outlet defers to every other same-critic outlet, never to another portal', () => {
  const others = ['variety', 'ap', 'msn', 'yahoo'];
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'yahoo', { sameCriticOutlets: others }).sort(), ['ap', 'variety']);
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'msn', { sameCriticOutlets: others }).sort(), ['ap', 'variety']);
});

test('without sameCriticOutlets (lane callers) the answer is unchanged; non-portals never get the rule', () => {
  assert.deepEqual(synd.getSyndicationPrimaries('Jesse Green', 'yahoo'), []);
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
