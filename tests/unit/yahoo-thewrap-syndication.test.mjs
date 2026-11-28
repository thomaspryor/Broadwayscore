/**
 * BRO-7237: Yahoo Entertainment reprints TheWrap's theater reviews under a yahoo.com URL. Wanted (2026-11-08) carried
 * Robert Hofler's review twice (thewrap 59, yahoo 62), so one critic counted twice in its score. syndication-pairs
 * makes thewrap the primary of a same-critic yahoo copy; the lane's syndication check and source coverage agree.
 *
 * Run: node --test tests/unit/yahoo-thewrap-syndication.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const synd = require('../../scripts/lib/syndication-pairs');
const { isUnflaggedSyndicationSecondary } = require('../../scripts/lib/rebuild-staleness-scan');
const ls = require('../../scripts/lib/opening-night-lane/lane-sources');

describe('TheWrap/Yahoo reprint', () => {
  it('makes thewrap the primary of a same-critic yahoo copy, for any TheWrap critic', () => {
    assert.deepStrictEqual(synd.getSyndicationPrimaries('Robert Hofler', 'yahoo'), ['thewrap']);
    assert.deepStrictEqual(synd.getSyndicationPrimaries('thom geier', 'yahoo'), ['thewrap']);
    assert.deepStrictEqual(synd.getSyndicationPrimaries('Robert Hofler', 'thewrap'), []);
    assert.deepStrictEqual(synd.getSyndicationPrimaries('unknown', 'yahoo'), []);
  });

  it('treats the two copies as one review', () => {
    const y = { criticName: 'Robert Hofler', outletId: 'yahoo' };
    const w = { criticName: 'Robert Hofler', outletId: 'thewrap' };
    assert.strictEqual(synd.isCrossOutletSyndicationPair(y, w), true);
    assert.strictEqual(synd.isCrossOutletSyndicationPair(y, { ...w, criticName: 'Thom Geier' }), false);
  });

  it('says on the night where Yahoo reviews are found (a stated gap, not a silent miss)', () => {
    const cov = ls.laneSourceCoverage(['yahoo', 'thewrap']);
    assert.deepStrictEqual(cov.missing, []);
    assert.match(cov.gaps.yahoo || '', /TheWrap/);
    assert.ok(cov.covered.thewrap && cov.covered.thewrap.length, 'the TheWrap feed is a lane source');
  });
});

describe('rebuild drops the Yahoo copy only while a live TheWrap copy exists', () => {
  let dir;
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7237-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wrap = (extra = {}) => ({
    showId: 'wanted-2022', criticName: 'Robert Hofler', outletId: 'thewrap', outlet: 'TheWrap',
    assignedScore: 59, fullText: 'A long enough review body. '.repeat(40), contentTier: 'complete', ...extra,
  });
  const yahoo = { showId: 'wanted-2022', criticName: 'Robert Hofler', outletId: 'yahoo', assignedScore: 62 };

  it('drops it beside a live TheWrap file, keeps it when the TheWrap file is flagged out', () => {
    write('yahoo--robert-hofler.json', yahoo);
    write('thewrap--robert-hofler.json', wrap());
    const files = fs.readdirSync(dir);
    assert.strictEqual(isUnflaggedSyndicationSecondary(yahoo, 'yahoo--robert-hofler.json', files, dir), true);
    write('thewrap--robert-hofler.json', wrap({ wrongProduction: true }));
    assert.strictEqual(isUnflaggedSyndicationSecondary(yahoo, 'yahoo--robert-hofler.json', files, dir), false);
  });

  it('keeps a Yahoo review whose critic has no TheWrap review of the show', () => {
    fs.rmSync(path.join(dir, 'thewrap--robert-hofler.json'));
    const files = fs.readdirSync(dir);
    assert.strictEqual(isUnflaggedSyndicationSecondary(yahoo, 'yahoo--robert-hofler.json', files, dir), false);
  });
});
