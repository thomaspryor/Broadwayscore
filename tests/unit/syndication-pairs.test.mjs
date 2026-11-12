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

test('primary files: any critic, never portals or unknown shadows', () => {
  const files = ['deadline--greg-evans.json', 'headtopics--deadline.json', 'newsbreak--x.json', 'yahoo--y.json', 'unknown--z.json', 'variety--a-b.json'];
  assert.deepEqual(synd.bylinelessPortalPrimaryFiles(files), ['deadline--greg-evans.json', 'variety--a-b.json']);
});

for (const [portal, critic] of [['headtopics', 'DEADLINE'], ['headtopics', null], ['newsbreak', 'Unknown']]) {
  test(`${portal} (byline ${critic}) is dropped when another outlet has a live review`, () => {
    const file = `${portal}--${critic ? critic.toLowerCase() : 'unknown'}.json`;
    const portalRev = rev(portal, critic);
    const dir = setup({ [file]: portalRev });
    assert.notEqual(explainExclusion(portalRev, show, path.join(dir, file)), 'knownSyndicationSecondary', 'alone: kept');
    fs.writeFileSync(path.join(dir, 'deadline--greg-evans.json'), JSON.stringify(rev('deadline', 'Greg Evans')));
    assert.equal(explainExclusion(portalRev, show, path.join(dir, file)), 'knownSyndicationSecondary');
    assert.notEqual(explainExclusion(rev('deadline', 'Greg Evans'), show, path.join(dir, 'deadline--greg-evans.json')), 'knownSyndicationSecondary');
  });
}

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
