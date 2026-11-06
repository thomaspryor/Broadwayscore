/**
 * BRO-6928: critic pages split by byline spelling. Runs the real emission path
 * (scripts/lib/critic-display-name.js displayCriticName, which rebuild-all-reviews.js
 * stamps into reviews.json) and the real page key (criticProfileKey) against the
 * committed alias table, so it needs no core data.
 *
 * Root causes this pins:
 *   1. aliases are stored punctuation-free ("samuel l") but were matched against the
 *      raw byline ("Samuel L."), so an alias could exist and never take effect;
 *   2. the critic registry's fold index kept a glued spelling ("MichaelArditti") and
 *      sent the aliased name to a second page;
 *   3. a new split had no gate: audit-critic-splits.js --strict now fails on one.
 * Run: node --test tests/unit/critic-spelling-duplicates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { displayCriticName } = require('../../scripts/lib/critic-display-name.js');
const { criticProfileKey } = require('../../scripts/lib/url-slug.js');
const { buildPages, findSplitPairs, newSplitPairs } = require('../../scripts/audit-critic-splits.js');
const AUTO_ALIASES = require('../../data/auto-critic-aliases.json').aliases;

const page = (name, outlet) => criticProfileKey(displayCriticName(name, outlet));

test('known split bylines land on one critic page', () => {
  // [variant byline, canonical byline, outlet] taken from reviews.json / review-texts
  const cases = [
    ['Christopher Caggiano', 'Chris Caggiano', 'DC Metro Theater Arts'],
    ['Andrjez Lukowski', 'Andrzej Lukowski', 'Time Out London'],
    ['Andrze Lukowski', 'Andrzej Lukowski', 'Time Out London'],
    ['Andrze] Lukowski', 'Andrzej Lukowski', 'Time Out London'],
    ['Jospeh Verlezza', 'Joseph Verlezza', 'Theatre Reviews Limited'],
    ['Samuel L.', 'Samuel L. Leiter', 'Theater Life'],
    ['Matt Windman. Special to AmNewYork', 'Matt Windman', 'amNewYork'],
    ['David Bendict', 'David Benedict', 'The Arts Desk'],
    ['Kathleen Foley', 'F. Kathleen Foley', 'Stage Raw'],
    ['Dave Cunningham', 'David Cunningham', 'The Reviews Hub'],
    ['Jeffrey Liebham', 'Jeffrey Leibham', 'Around the Town Chicago'],
    ['Alyssa Mutterperi', 'Alyssa Mutterperl', 'Maryland Theatre Guide'],
    ['Jonas Schwartz-Owen', 'Jonas Schwartz', 'BroadwayWorld'],
    ['MichaelArditti', 'Michael Arditti', 'Sunday Express'],
    ['Rachel Ha!liburton', 'Rachel Halliburton', 'Time Out London'],
  ];
  for (const [variant, canonical, outlet] of cases) {
    const want = page(canonical, outlet);
    assert.ok(want, `${canonical} has a page`);
    assert.equal(page(variant, outlet), want, `${variant} → ${canonical}`);
  }
});

test('different people keep separate pages', () => {
  const cases = [
    ['Stu Brown', 'Scott Brown', 'X'],
    ['Marina Kennedy', 'Mark Kennedy', 'X'],
    ['Jess Green', 'Jesse Green', 'Musical Theatre Review'],
    ['Sarah Larson', 'Sarah Carson', 'The New Yorker'],
    ['Simon Thomson', 'Simon Thompson', 'City A.M.'],
    ['G. Bruce Smith', 'Bruce Smith', 'Stage Raw'],
  ];
  for (const [a, b, outlet] of cases) assert.notEqual(page(a, outlet), page(b, outlet), `${a} / ${b}`);
});

test('every alias in data/auto-critic-aliases.json takes effect, with or without punctuation', () => {
  // "g bruce smith" may arrive as "G. Bruce Smith": title-case each word and put a
  // period after a lone initial, the way bylines are written.
  const byline = (s) => s.split(' ').map((w) => (w.length === 1 ? w.toUpperCase() + '.' : w[0].toUpperCase() + w.slice(1))).join(' ');
  // The key is the page the person's reviews live on (detect-critic-typos.js and
  // audit-critic-splits.js --apply write the canonical PAGE slug), so every alias, in any
  // punctuation, must land there. "holly-omahony" once missed Holly O'Mahony's real page.
  const broken = [];
  for (const [canonical, aliases] of Object.entries(AUTO_ALIASES)) {
    for (const alias of aliases) {
      for (const form of [alias, byline(alias)]) {
        const got = page(form);
        if (got && got !== canonical) broken.push(`${form} → ${got}, want ${canonical}`);
      }
    }
  }
  assert.deepEqual(broken, [], `aliases that do not merge:\n${broken.join('\n')}`);
});

test('the split gate fails on a NEW pair and passes once an alias fixes it', () => {
  const reviews = [
    ...Array.from({ length: 40 }, (_, i) => ({ criticName: 'Joseph Verlezza', outlet: 'Theatre Reviews Limited', showId: `s${i}` })),
    { criticName: 'Josehp Verlezza', outlet: 'Theatre Reviews Limited', showId: 'x' },
  ];
  const pairs = findSplitPairs(buildPages(reviews), { distinct: new Set() });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].verdict, 'merge');
  // not in the baseline, no alias → the gate fails
  assert.equal(newSplitPairs(pairs, new Set()).length, 1);
  // a held pair in the baseline does not fail
  assert.equal(newSplitPairs(pairs, new Set([pairs[0].key])).length, 0);
  // a pair whose variant an alias already resolves does not fail (reviews.json catches up)
  const fixed = [{ ...pairs[0], variant: { ...pairs[0].variant, name: 'Jospeh Verlezza' } }];
  assert.equal(newSplitPairs(fixed, new Set()).length, 0);
});
