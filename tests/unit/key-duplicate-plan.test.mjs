import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planKeyGroup, chooseCanonical, normUrl } = require('../../scripts/lib/key-duplicate-plan.js');

const f = (file, extra = {}) => ({ file, url: null, head: '', textLen: 3000, tier: 'complete', hrs: null, orig: null, ...extra });

test('normUrl ignores scheme, www, query, hash and trailing slash', () => {
  assert.equal(normUrl('https://www.Example.com/a/b/?x=1#y'), normUrl('http://example.com/a/b'));
  assert.equal(normUrl('not a url'), null);
});

test('same URL: the --unknown copy is dropped in favour of the named file', () => {
  const r = planKeyGroup([
    f('timeout--unknown.json', { url: 'https://www.timeout.com/london/theatre/x-review' }),
    f('timeout--jo-bloggs.json', { url: 'https://timeout.com/london/theatre/x-review/' }),
  ]);
  assert.deepEqual(r.actions.map((a) => [a.kind, a.file, a.to]), [['duplicateOf', 'timeout--unknown.json', 'timeout--jo-bloggs.json']]);
});

test('a critic rating on the --unknown copy outranks the byline (the score is the data)', () => {
  const { keep, drop } = chooseCanonical(f('wos--unknown.json', { orig: '4/5 stars' }), f('wos--sarah-crompton.json'));
  assert.equal(keep.file, 'wos--unknown.json');
  assert.equal(drop.file, 'wos--sarah-crompton.json');
});

test('same opening text on different URLs is the same review', () => {
  const head = 'A long opening paragraph about the revival '.repeat(8);
  const r = planKeyGroup([f('a--x.json', { url: 'https://a.com/1', head }), f('a--unknown.json', { url: 'https://a.com/2', head })]);
  assert.equal(r.actions[0].kind, 'duplicateOf');
  assert.equal(r.actions[0].file, 'a--unknown.json');
});

test('different articles: only the file whose own name is in its text and not its stamped name gets a criticName fix', () => {
  const r = planKeyGroup([
    f('variety--david-rooney.json', { url: 'https://v.com/1', head: 'one '.repeat(60), critic: 'steven suskin', bylineFile: true, bylineField: false }),
    f('variety--steven-suskin.json', { url: 'https://v.com/2', head: 'two '.repeat(60), critic: 'steven suskin', bylineFile: true, bylineField: true }),
  ]);
  assert.deepEqual(r.actions.map((a) => [a.kind, a.file, a.newName]), [['criticName', 'variety--david-rooney.json', 'David Rooney']]);
});

test('inconclusive evidence and groups of three are left for a human', () => {
  const r = planKeyGroup([
    f('v--a-b.json', { url: 'https://v.com/1', head: 'one '.repeat(60), bylineFile: null, bylineField: null }),
    f('v--c-d.json', { url: 'https://v.com/2', head: 'two '.repeat(60), bylineFile: null, bylineField: null }),
  ]);
  assert.equal(r.actions.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(planKeyGroup([f('1.json'), f('2.json'), f('3.json')]).ambiguous.length, 1);
});
