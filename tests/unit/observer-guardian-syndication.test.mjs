/**
 * BRO-6046: The Observer prints on theguardian.com, so one Observer column was
 * filed twice (observer from Theatre Record, guardian from the Guardian API /
 * web search) and counted twice in six show scores. syndication-pairs'
 * PUBLISHING_GROUPS makes observer the primary; the rebuild shield, the
 * staleness scan and the published-pairs audit must all agree.
 *
 * Run: node --test tests/unit/observer-guardian-syndication.test.mjs
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
const { findSyndicatedCriticPairs } = require('../../scripts/audit-syndicated-critic-pairs');

describe('Observer/Guardian publishing group', () => {
  it('makes observer the primary of a same-critic guardian copy', () => {
    assert.deepStrictEqual(synd.getSyndicationPrimaries('susannah clapp', 'guardian'), ['observer']);
    assert.deepStrictEqual(synd.getSyndicationPrimaries('Kate Kellaway', 'guardian'), ['observer']);
    assert.deepStrictEqual(synd.getSyndicationPrimaries('susannah clapp', 'observer'), []);
  });

  it('never applies to an unknown byline', () => {
    assert.deepStrictEqual(synd.getSyndicationPrimaries('unknown', 'guardian'), []);
  });

  it('keeps a cross-outlet duplicateOf pointer between the two copies durable', () => {
    const g = { criticName: 'Susannah Clapp', outletId: 'guardian' };
    const o = { criticName: 'Susannah Clapp', outletId: 'observer' };
    assert.strictEqual(synd.isCrossOutletSyndicationPair(g, o), true);
    assert.strictEqual(synd.isCrossOutletSyndicationPair(g, { ...o, criticName: 'Kate Kellaway' }), false);
  });
});

describe('rebuild-staleness-scan mirrors the shield for publishing groups', () => {
  let dir;
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6046-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const observer = (extra = {}) => ({
    showId: 'rose-west-end-2023', criticName: 'Susannah Clapp', outletId: 'observer', outlet: 'The Observer',
    assignedScore: 80, fullText: 'A long enough review body. '.repeat(40), contentTier: 'complete', ...extra,
  });

  it('treats the guardian copy as a secondary only while a live observer copy exists', () => {
    const guardian = { criticName: 'Susannah Clapp', outletId: 'guardian' };
    write('guardian--susannah-clapp.json', guardian);
    write('observer--susannah-clapp.json', observer());
    const files = fs.readdirSync(dir);
    assert.strictEqual(isUnflaggedSyndicationSecondary(guardian, 'guardian--susannah-clapp.json', files, dir), true);

    write('observer--susannah-clapp.json', observer({ wrongProduction: true }));
    assert.strictEqual(isUnflaggedSyndicationSecondary(guardian, 'guardian--susannah-clapp.json', files, dir), false);
  });

  it('releases the guardian copy when the observer copy has no score', () => {
    const guardian = { criticName: 'Susannah Clapp', outletId: 'guardian' };
    write('observer--susannah-clapp.json', observer({ assignedScore: null }));
    assert.strictEqual(isUnflaggedSyndicationSecondary(guardian, 'guardian--susannah-clapp.json', fs.readdirSync(dir), dir), false);
  });

  it('never lets a misnamed primary file shield a different critic', () => {
    write('observer--jesse-green.json', observer({ criticName: 'David Cote' }));
    assert.strictEqual(synd.hasLiveSyndicationPrimary(dir, ['observer'], 'jesse green'), false);
    write('observer--jesse-green.json', observer({ criticName: 'Jesse Green' }));
    assert.strictEqual(synd.hasLiveSyndicationPrimary(dir, ['observer'], 'jesse green'), true);
  });

  it('never treats the primary as a secondary of itself', () => {
    const observer = { criticName: 'Susannah Clapp', outletId: 'observer' };
    assert.strictEqual(isUnflaggedSyndicationSecondary(observer, 'observer--susannah-clapp.json', fs.readdirSync(dir), dir), false);
  });
});

describe('findSyndicatedCriticPairs', () => {
  it('flags one critic shipped under both observer and guardian for one show', () => {
    const pairs = findSyndicatedCriticPairs([
      { showId: 'rose-west-end-2023', outletId: 'observer', criticName: 'Kate Kellaway' },
      { showId: 'rose-west-end-2023', outletId: 'guardian', criticName: 'Kate Kellaway' },
      { showId: 'rose-west-end-2023', outletId: 'guardian', criticName: 'Arifa Akbar' },
      { showId: 'other-show', outletId: 'guardian', criticName: 'Kate Kellaway' },
    ]);
    assert.deepStrictEqual(pairs, [{ showId: 'rose-west-end-2023', criticName: 'Kate Kellaway', secondary: 'guardian', primary: 'observer' }]);
  });

  it('ignores different critics and rows without a byline', () => {
    assert.deepStrictEqual(findSyndicatedCriticPairs([
      { showId: 's', outletId: 'observer', criticName: 'Susannah Clapp' },
      { showId: 's', outletId: 'guardian', criticName: 'Michael Billington' },
      { showId: 's', outletId: 'guardian' },
    ]), []);
  });
});
