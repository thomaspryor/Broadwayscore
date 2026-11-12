// BRO-7416: byline-less aggregator portals (headtopics/newsbreak) never count as a separate review when any
// other outlet's live review of the show exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const synd = require('../../scripts/lib/syndication-pairs.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');

const rev = (outletId, criticName, extra = {}) => ({
  showId: 'test-show-2026', outletId, outlet: outletId, criticName, url: `https://${outletId}.example/r`,
  publishDate: '2026-11-01', assignedScore: 62, contentTier: 'complete',
  fullText: 'A full review of the production. '.repeat(40), ...extra,
});
const show = { id: 'test-show-2026', title: 'Test Show', openingDate: '2026-11-01', status: 'open' };
function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7416-'));
  for (const [name, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(d));
  return dir;
}

test('portal registry names headtopics and newsbreak', () => {
  assert.ok(synd.isBylinelessPortalOutlet('headtopics'));
  assert.ok(synd.isBylinelessPortalOutlet('newsbreak'));
  assert.ok(!synd.isBylinelessPortalOutlet('deadline'));
});

test('primary files: only the outlet the portal names, never portals or unknown shadows', () => {
  const files = ['deadline--greg-evans.json', 'headtopics--deadline.json', 'newsbreak--x.json', 'yahoo--y.json', 'unknown--deadline.json', 'variety--a-b.json'];
  assert.deepEqual(synd.bylinelessPortalPrimaryFiles(files, { criticName: 'DEADLINE', fileName: 'headtopics--deadline.json' }), ['deadline--greg-evans.json']);
  assert.deepEqual(synd.bylinelessPortalPrimaryFiles(files, { criticName: null, fileName: 'headtopics--deadline.json' }), ['deadline--greg-evans.json']);
  assert.deepEqual(synd.bylinelessPortalPrimaryFiles(files, { criticName: 'Unknown', fileName: 'newsbreak--unknown.json' }), []);
});

test('headtopics (byline names the source outlet) is dropped when that outlet has a live review', () => {
  for (const critic of ['DEADLINE', null]) {
    const portalRev = rev('headtopics', critic);
    const file = 'headtopics--deadline.json';
    const dir = setup({ [file]: portalRev });
    assert.notEqual(explainExclusion(portalRev, show, path.join(dir, file)), 'knownSyndicationSecondary', 'alone: kept');
    fs.writeFileSync(path.join(dir, 'deadline--greg-evans.json'), JSON.stringify(rev('deadline', 'Greg Evans')));
    assert.equal(explainExclusion(portalRev, show, path.join(dir, file)), 'knownSyndicationSecondary');
    assert.notEqual(explainExclusion(rev('deadline', 'Greg Evans'), show, path.join(dir, 'deadline--greg-evans.json')), 'knownSyndicationSecondary');
  }
});

test('a portal copy with no live copy of the outlet it names stays (Phantom/Klein: none; suffs: original is a flagged copy)', () => {
  const hs = rev('headtopics', 'Cleveland Scene');
  const nb = rev('newsbreak', 'Christianne Klein');
  const dir = setup({
    'headtopics--clevelandscene.json': hs, 'newsbreak--christianne-klein.json': nb,
    'cleveland-plain-dealer--joey-morona.json': rev('cleveland-plain-dealer', 'Joey Morona'),
    'variety--someone-else.json': rev('variety', 'Someone Else'),
    'clevelandscene--gwendolyn-kochur.json': rev('clevelandscene', 'Gwendolyn Kochur', { crossOutletDuplicate: true, crossOutletPrimaryFile: 'x/headtopics--clevelandscene.json' }),
  });
  assert.notEqual(explainExclusion(hs, show, path.join(dir, 'headtopics--clevelandscene.json')), 'knownSyndicationSecondary');
  assert.notEqual(explainExclusion(nb, show, path.join(dir, 'newsbreak--christianne-klein.json')), 'knownSyndicationSecondary');
});

test('a newsbreak copy with a real byline defers to the same critic at another outlet (portal rule)', () => {
  const nb = rev('newsbreak', 'Jami Ganz');
  const dir = setup({ 'newsbreak--jami-ganz.json': nb, 'ew--jami-ganz.json': rev('ew', 'Jami Ganz'), 'variety--x-y.json': rev('variety', 'X Y') });
  assert.equal(explainExclusion(nb, show, path.join(dir, 'newsbreak--jami-ganz.json')), 'knownSyndicationSecondary');
});

test('dedup-survivor orders the portal after the outlet it names', () => {
  const { primaryFilesFor } = require('../../scripts/lib/dedup-survivor.js');
  const files = ['headtopics--deadline.json', 'deadline--greg-evans.json', 'variety--a-b.json'];
  assert.deepEqual(primaryFilesFor('headtopics--deadline.json', { criticName: 'DEADLINE', outletKey: 'headtopics' }, files), ['deadline--greg-evans.json']);
});

test('a dead (flagged) other-outlet review does not shield the portal copy', () => {
  const portalRev = rev('headtopics', 'DEADLINE');
  const dir = setup({
    'headtopics--deadline.json': portalRev,
    'deadline--greg-evans.json': rev('deadline', 'Greg Evans', { isNonReview: true }),
  });
  assert.notEqual(explainExclusion(portalRev, show, path.join(dir, 'headtopics--deadline.json')), 'knownSyndicationSecondary');
});

test('rebuild-all-reviews and scoring-delta both carry the portal rule (no drift)', () => {
  for (const f of ['../../scripts/rebuild-all-reviews.js', '../../scripts/scoring-delta.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /hasLiveBylinelessPortalPrimary/, f);
  }
});

test('cross-outlet detector breaks primary ties against portals (suffs: headtopics must not outrank clevescene)', () => {
  assert.equal(synd.portalRank('headtopics'), 1);
  assert.equal(synd.portalRank('clevescene'), 0);
  const src = fs.readFileSync(new URL('../../scripts/detect-cross-outlet-duplicates.js', import.meta.url), 'utf8');
  assert.equal((src.match(/portalRank\(/g) || []).length >= 4, true, 'both primary-selection sites use portalRank');
});

test('portal filename with a --on-<date> suffix still names its outlet', () => {
  const files = ['headtopics--deadline--on-2026-11-08.json', 'deadline--greg-evans.json'];
  assert.deepEqual(synd.bylinelessPortalPrimaryFiles(files, { criticName: null, fileName: files[0] }), ['deadline--greg-evans.json']);
});
