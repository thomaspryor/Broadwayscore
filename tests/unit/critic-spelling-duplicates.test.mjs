// LIVE-DATA-LANE: reads data/auto-critic-aliases.json (read by the test); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
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
 *      sent the aliased name to a second page; a raw spelling that slugified to the
 *      alias key ("Holly OMahony") kept its own page even when the canonical's page
 *      is another (holly-o-mahony);
 *   3. a new split had no gate: audit-critic-splits.js --strict now fails on one.
 * Run: node --test tests/unit/critic-spelling-duplicates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { displayCriticName, displayFormForCanonical } = require('../../scripts/lib/critic-display-name.js');
const { CRITIC_ALIASES, loadOutletRegistry, slugify } = require('../../scripts/lib/review-normalization.js');
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
  // Every spelling of an alias, in any punctuation, lands on the page the canonical's
  // display form lives on (keys follow review-normalization's slugify, pages url-slug's,
  // so "holly-omahony" is the key and holly-o-mahony the page).
  const broken = [];
  for (const [canonical, aliases] of Object.entries(AUTO_ALIASES)) {
    const want = criticProfileKey(displayFormForCanonical(canonical));
    for (const alias of aliases) {
      for (const form of [alias, byline(alias)]) {
        const got = page(form);
        if (got && got !== want) broken.push(`${form} → ${got}, want ${want} (${canonical})`);
      }
    }
  }
  assert.deepEqual(broken, [], `aliases that do not merge:\n${broken.join('\n')}`);
});

test('an aliased critic gets the same page at their own outlet as anywhere else', () => {
  // An outlet's defaultCritic is preferred as the display form, so without a fixes
  // entry "Karen D'Souza" was karen-d-souza at the Mercury News, karen-dsouza elsewhere.
  const reg = loadOutletRegistry();
  const broken = [];
  for (const [id, e] of Object.entries(reg.outlets || reg)) {
    const dc = e && typeof e.defaultCritic === 'string' ? e.defaultCritic.trim() : '';
    const slug = dc && slugify(dc);
    if (!slug || !CRITIC_ALIASES[slug]) continue;
    const outlet = e.displayName || e.name || id;
    for (const form of [dc, ...CRITIC_ALIASES[slug]]) {
      const at = page(form, outlet), elsewhere = page(form);
      if (at !== elsewhere) broken.push(`${form} @${outlet}: ${at} vs ${elsewhere}`);
    }
  }
  assert.deepEqual(broken, [], `add a critic-name-fixes.json entry:\n${broken.join('\n')}`);
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
  // once an alias resolves the variant, the gate passes (reviews.json catches up at rebuild)
  CRITIC_ALIASES['joseph-verlezza'].push('josehp verlezza');
  try {
    assert.equal(newSplitPairs(pairs, new Set()).length, 0);
  } finally {
    CRITIC_ALIASES['joseph-verlezza'].pop();
  }
});

test('the split gate checks every spelling and outlet on the variant page', () => {
  const reviews = [
    ...Array.from({ length: 40 }, (_, i) => ({ criticName: 'Joseph Verlezza', outlet: 'Theatre Reviews Limited', showId: `s${i}` })),
    // two spellings on one variant page ("Jospeh Verlezza" and "Jospeh Verlezza.")
    { criticName: 'Jospeh Verlezza', outlet: 'Theatre Reviews Limited', showId: 'x' },
    { criticName: 'Jospeh Verlezza', outlet: 'Theatre Reviews Limited', showId: 'y' },
    { criticName: 'Jospeh Verlezza.', outlet: 'Theatre Reviews Limited', showId: 'z' },
  ];
  const pairs = findSplitPairs(buildPages(reviews), { distinct: new Set() });
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].variant.spellings.sort(), ['Jospeh Verlezza', 'Jospeh Verlezza.']);
  // both spellings resolve today, so nothing fails
  assert.equal(newSplitPairs(pairs, new Set()).length, 0);
  // a spelling the alias table cannot reach keeps the page alive: the gate fails
  const held = [{ ...pairs[0], variant: { ...pairs[0].variant, spellings: [...pairs[0].variant.spellings, 'Jospeh Verlezzza'] } }];
  assert.equal(newSplitPairs(held, new Set()).length, 1);
});
