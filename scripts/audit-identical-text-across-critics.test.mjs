/**
 * Tests for scripts/audit-identical-text-across-critics.js (BRO-5401).
 * Run: node --test scripts/audit-identical-text-across-critics.test.mjs
 *
 * The audit finds one article stored under two named critics on a show. The
 * byline check (scripts/lib/identical-text-verdict.js) then says whether the
 * copy that is shown carries the byline printed on the live page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { identicalTextGroups, isUnresolvedGroup, MIN_CHARS } = require('./audit-identical-text-across-critics.js');
const { groupVerdict } = require('./lib/identical-text-verdict.js');

const body = (seed) => Array.from({ length: 120 }, (_, i) => `${seed}word${i}`).join(' ');
const row = (showId, file, fullText, extra = {}) => ({
  showId, file, rel: `${showId}/${file}`, d: { fullText, criticName: file.split('--')[1].replace('.json', ''), ...extra },
});

test('same article under two critics on one show is a group', () => {
  const t = body('a');
  const g = identicalTextGroups([
    row('aladdin-2014', 'theatermania--zachary-stewart.json', t),
    row('aladdin-2014', 'theatermania--charles-isherwood.json', `${t}   `),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 2);
});

test('same text under one critic, different shows, different text, and short stubs are not groups', () => {
  const t = body('b');
  assert.equal(identicalTextGroups([
    row('s1', 'variety--david-rooney.json', t),
    row('s1', 'variety--david-rooney.json', t),
  ]).length, 0, 'one critic');
  assert.equal(identicalTextGroups([
    row('s1', 'variety--david-rooney.json', t),
    row('s2', 'variety--marilyn-stasio.json', t),
  ]).length, 0, 'different shows');
  assert.equal(identicalTextGroups([
    row('s1', 'variety--david-rooney.json', body('c')),
    row('s1', 'variety--marilyn-stasio.json', body('d')),
  ]).length, 0, 'different text');
  const exact = 'x'.repeat(MIN_CHARS);
  assert.equal(identicalTextGroups([
    row('s1', 'variety--david-rooney.json', exact),
    row('s1', 'variety--marilyn-stasio.json', exact),
  ]).length, 1, 'exactly MIN_CHARS counts');
  const stub = 'x'.repeat(MIN_CHARS - 1);
  assert.equal(identicalTextGroups([
    row('s1', 'variety--david-rooney.json', stub),
    row('s1', 'variety--marilyn-stasio.json', stub),
  ]).length, 0, 'short stub');
});

test('a group is resolved once one copy is excluded or points at the other as its duplicate', () => {
  const t = body('e');
  const a = row('s1', 'nytimes--jesse-green.json', t);
  const b = row('s1', 'nytimes--erik-piepenburg.json', t);
  assert.equal(isUnresolvedGroup([a, b]), true);
  const excluded = row('s1', 'nytimes--jesse-green.json', t, { wrongAttribution: true });
  assert.equal(isUnresolvedGroup([excluded, b]), false);
  const twin = row('s1', 'nytimes--jesse-green.json', t, { duplicateTextOf: b.file });
  assert.equal(isUnresolvedGroup([twin, b]), false);
  const strayPointer = row('s1', 'nytimes--jesse-green.json', t, { duplicateTextOf: 'nytimes--someone-else.json' });
  assert.equal(isUnresolvedGroup([strayPointer, b]), true, 'a pointer outside the group settles nothing');
  const c = row('s1', 'nytimes--ben-brantley.json', t);
  assert.equal(isUnresolvedGroup([excluded, b, c]), true, 'two live copies of three still count twice');
});

test('byline verdict: flags a shown copy whose byline differs from the live page, passes one that matches', () => {
  const members = [
    { file: 'variety--marilyn-stasio.json', critic: 'Marilyn Stasio', url: 'https://variety.com/2012/legit/reviews/scandalous-1117948755/', shown: true },
    { file: 'variety--steven-suskin.json', critic: 'Steven Suskin', url: 'https://variety.com/2012/legit/reviews/scandalous-1117948755/', shown: false },
  ];
  const pageBy = (name) => [{ url: members[0].url, authors: [`jsonld: ${name}`, 'byline: By Andrew Wallenstein'], overlap: 1 }];

  const wrong = groupVerdict(members, pageBy('Steven Suskin'));
  assert.equal(wrong.kind, 'shown-wrong');
  assert.equal(wrong.author, 'Steven Suskin');
  assert.deepEqual(wrong.right, ['variety--steven-suskin.json']);

  const ok = groupVerdict(members, pageBy('Marilyn Stasio'));
  assert.equal(ok.kind, 'shown-correct', 'matching byline is not flagged');

  const nobody = groupVerdict(members, pageBy('Someone Else'));
  assert.equal(nobody.kind, 'author-not-stored');
});

test('byline verdict: with different urls, a page that does not carry the text or has no structured author stays unverified', () => {
  const members = [
    { file: 'a--x-y.json', critic: 'X Y', url: 'https://a.example/1', shown: true },
    { file: 'a--p-q.json', critic: 'P Q', url: 'https://a.example/2', shown: false },
  ];
  assert.equal(groupVerdict(members, [{ url: 'https://a.example/1', authors: ['jsonld: X Y'], overlap: 0.1 }]).kind, 'unverified');
  assert.equal(groupVerdict(members, [{ url: 'https://a.example/1', authors: ['byline: By Staff Writer'], overlap: 1 }]).kind, 'unverified');
});

test('byline verdict: copies that share one url take the byline of that url even when the text overlap is low', () => {
  const members = [
    { file: 'a--x-y.json', critic: 'X Y', url: 'https://a.example/1', shown: true },
    { file: 'a--p-q.json', critic: 'P Q', url: 'https://a.example/1', shown: false },
  ];
  const v = groupVerdict(members, [{ url: 'https://a.example/1', authors: ['jsonld: P Q'], overlap: 0.1 }]);
  assert.equal(v.basis, 'same-url-byline');
  assert.equal(v.kind, 'shown-wrong');
});
