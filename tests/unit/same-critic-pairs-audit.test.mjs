/**
 * BRO-6054: one named critic shipping a show at two outlets is a double count
 * or a wrong outlet attribution unless syndication-pairs explains it or the
 * allowlist names it as two separate reviews. The audit must catch the rest.
 *
 * Run: node --test tests/unit/same-critic-pairs-audit.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findUnexplainedSameCriticPairs, findSyndicatedCriticPairs } = require('../../scripts/audit-syndicated-critic-pairs');
const allowlist = require('../../scripts/config/same-critic-pairs-allowlist.json').pairs;

const row = (showId, outletId, criticName) => ({ showId, outletId, criticName });

describe('findUnexplainedSameCriticPairs', () => {
  it('flags a critic at two unrelated outlets (sibling-critic copy)', () => {
    const { unexplained } = findUnexplainedSameCriticPairs([
      row('red-2010', 'variety', 'Charles Isherwood'), row('red-2010', 'nytimes', 'Charles Isherwood'),
    ]);
    assert.deepStrictEqual(unexplained, [{ showId: 'red-2010', criticName: 'Charles Isherwood', outlets: ['nytimes', 'variety'] }]);
  });

  it('leaves syndication pairs to findSyndicatedCriticPairs', () => {
    const rows = [row('x-2015', 'nyt-theater', 'Jonathan Mandell'), row('x-2015', 'dctheatrescene', 'Jonathan Mandell')];
    assert.strictEqual(findUnexplainedSameCriticPairs(rows).unexplained.length, 0);
    assert.strictEqual(findSyndicatedCriticPairs(rows).length, 1);
  });

  it('allowlisted pairs pass, match case-insensitively and in either order', () => {
    const rows = [row('wicked-2003', 'variety', 'charles isherwood'), row('wicked-2003', 'nytimes', 'Charles Isherwood')];
    const { unexplained, stale } = findUnexplainedSameCriticPairs(rows, allowlist);
    assert.strictEqual(unexplained.length, 0);
    assert.ok(!stale.some(e => e.showId === 'wicked-2003'));
  });

  it('three outlets with one allowlisted pair still flags the other two pairs', () => {
    const rows = ['nytimes', 'vulture', 'theatermania'].map(o => row('hello-dolly-2017', o, 'Jesse Green'));
    const { unexplained } = findUnexplainedSameCriticPairs(rows, allowlist);
    assert.deepStrictEqual(unexplained.map(u => u.outlets.join('+')).sort(), ['nytimes+theatermania', 'theatermania+vulture']);
  });

  it('groups name variants of one critic (diacritics, spacing)', () => {
    const { unexplained } = findUnexplainedSameCriticPairs([
      row('s-2020', 'a', 'Hélène  Smith'), row('s-2020', 'b', 'Helene Smith'),
    ]);
    assert.deepStrictEqual(unexplained.map(u => u.outlets.join('+')), ['a+b']);
  });

  it('ignores placeholder bylines and single-outlet critics', () => {
    const rows = [row('s', 'a', 'Unknown'), row('s', 'b', 'unknown'), row('s', 'c', 'Staff'), row('s', 'd', 'Staff'), row('s', 'a', 'Ben Brantley')];
    assert.strictEqual(findUnexplainedSameCriticPairs(rows).unexplained.length, 0);
  });

  it('reports allowlist entries with no matching rows as stale', () => {
    const { stale } = findUnexplainedSameCriticPairs([], allowlist);
    assert.strictEqual(stale.length, allowlist.length);
  });
});

describe('same-critic-pairs allowlist', () => {
  it('every entry names a show, a critic, two distinct outlets and a reason, with no duplicates', () => {
    const keys = new Set();
    for (const e of allowlist) {
      assert.ok(e.showId && e.critic && e.reason, JSON.stringify(e));
      assert.strictEqual(e.outlets.length, 2);
      assert.notStrictEqual(e.outlets[0], e.outlets[1]);
      const k = [e.showId, e.critic.toLowerCase(), ...[...e.outlets].sort()].join('|');
      assert.ok(!keys.has(k), `duplicate ${k}`);
      keys.add(k);
    }
  });
});

describe('SFGate blank bylines', () => {
  it('are not filled with the Chronicle critic (BCN wire reviews read as her double count)', () => {
    const { shouldFillDefaultCritic } = require('../../scripts/lib/critic-fill-rules.js');
    const registry = require('../../data/outlet-registry.json');
    assert.strictEqual(shouldFillDefaultCritic(registry.outlets.sfgate), false);
  });
});
