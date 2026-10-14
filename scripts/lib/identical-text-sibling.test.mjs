/**
 * Tests for scripts/lib/identical-text-sibling.js and the shared same-article
 * key, review-normalization.canonicalArticleKey (BRO-5321).
 * Run: node --test scripts/lib/identical-text-sibling.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findIdenticalTextSibling } = require('./identical-text-sibling.js');
const { canonicalArticleKey } = require('./review-normalization.js');

const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
const rooney = { file: 'variety--david-rooney.json', data: { criticName: 'David Rooney', outletId: 'variety', fullText: text } };
const incoming = { criticName: 'Charles Isherwood', outletId: 'variety', fullText: `  ${text.replace(/ /g, '\n')} ` };
const run = (over = {}) => findIdenticalTextSibling({ thisFile: 'variety--charles-isherwood.json', newData: incoming, existingData: null, siblings: [rooney], ...over });

test('flags a new body that a sibling holds word for word under another critic', () => {
  assert.equal(run(), 'variety--david-rooney.json');
});

test('leaves text already on disk alone (legacy pairs are byline work, not a silent flip)', () => {
  assert.equal(run({ existingData: { fullText: text } }), null);
});

test('skips placeholder and same-critic copies (merge and rename flows)', () => {
  assert.equal(run({ newData: { ...incoming, criticName: 'Unknown' } }), null);
  assert.equal(run({ newData: { ...incoming, criticName: 'David Rooney', outletId: 'nytimes' } }), null);
});

test('never points at a non-canonical, a wrongAttribution row, or back at a file pointing here', () => {
  for (const extra of [{ duplicateOf: 'x.json' }, { duplicateTextOf: 'x.json' }, { wrongAttribution: true }, { duplicateOf: 'variety--charles-isherwood.json' }]) {
    assert.equal(run({ siblings: [{ ...rooney, data: { ...rooney.data, ...extra } }] }), null);
  }
});

test('same outlet only, and never points at an excluded sibling', () => {
  assert.equal(run({ siblings: [{ file: 'nytimes--david-rooney.json', data: { ...rooney.data, outletId: 'nytimes' } }] }), null);
  for (const extra of [{ wrongProduction: true }, { isNonReview: true }, { contentTier: 'invalid' }]) {
    assert.equal(run({ siblings: [{ ...rooney, data: { ...rooney.data, ...extra } }] }), null);
  }
});

test('honours an explicit clear and short or different text', () => {
  assert.equal(run({ newData: { ...incoming, duplicateTextOfCleared: true } }), null);
  assert.equal(run({ newData: { ...incoming, fullText: 'short text' } }), null);
  assert.equal(run({ newData: { ...incoming, fullText: `${text} extra` } }), null);
});

test('safeWriteReview sets duplicateTextOf on a cross-critic copy and keeps the text', async () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5321-'));
  const show = path.join(dir, 'deuce-2007');
  fs.mkdirSync(show);
  fs.writeFileSync(path.join(show, rooney.file), JSON.stringify({ ...rooney.data, showId: 'deuce-2007', url: 'https://variety.com/2007/legit/reviews/deuce-1200558841/' }));
  const target = path.join(show, 'variety--charles-isherwood.json');
  await safeWriteReview(target, { ...incoming, showId: 'deuce-2007', outlet: 'Variety', url: 'https://variety.com/2007/legit/reviews/deuce-1200558823/' }, { skipGitLog: true });
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.duplicateTextOf, 'variety--david-rooney.json');
  assert.ok(written.fullText.length > 400);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a urlVerified url stays locked against an alias-host rewrite (no wipe)', async () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5321-lock-'));
  const show = path.join(dir, 'x-2010');
  fs.mkdirSync(show);
  const target = path.join(show, 'nytimes--ben-brantley.json');
  const url = 'https://www.nytimes.com/2010/10/13/theater/reviews/13life.html';
  const rec = { showId: 'x-2010', outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Ben Brantley', url, urlVerified: true, fullText: text, assignedScore: 80, publishDate: '2010-10-13' };
  fs.writeFileSync(target, JSON.stringify(rec));
  await safeWriteReview(target, { ...rec, url: 'http://theater.nytimes.com/2010/10/13/theater/reviews/13life.html' }, { skipGitLog: true });
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.url, url);
  assert.equal(written.assignedScore, 80);
  assert.ok(written.fullText);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canonicalArticleKey: one article across scheme, www, legacy host and Variety slug', () => {
  const k = canonicalArticleKey;
  assert.equal(k('http://theater.nytimes.com/2010/10/13/theater/reviews/13life.html'), k('https://www.nytimes.com/2010/10/13/theater/reviews/13life.html'));
  assert.equal(k('https://variety.com/2007/legit/reviews/deuce-1200558823/'), k('http://www.variety.com/2007/legit/reviews/deuce-the-play-1200558823'));
  assert.equal(k('http://www.variety.com/review/VE1117946930.html?categoryid=33&cs=1', { ignoreQuery: true }), k('https://variety.com/2012/legit/reviews/clybourne-park-2-1117946930/'));
  assert.notEqual(k('https://variety.com/2007/legit/reviews/deuce-1200558823/'), k('https://variety.com/2007/legit/reviews/deuce-1200558841/'));
  // The setter keeps query ids; only the clearer (ignoreQuery) drops them.
  assert.notEqual(k('https://example.com/r.php?id=1'), k('https://example.com/r.php?id=2'));
  assert.equal(k('https://example.com/r.php?id=1', { ignoreQuery: true }), k('https://example.com/r.php?id=2', { ignoreQuery: true }));
  // A registry alias that is another outlet's primary domain never folds.
  assert.equal(k('https://abcnews.go.com/x'), 'abcnews.go.com/x');
});

test('ratchet: a group is unresolved only while 2+ copies remain eligible', () => {
  const { isUnresolvedGroup } = require('../audit-identical-text-across-critics.js');
  const a = { file: 'a.json', d: { criticName: 'A B' } };
  const b = { file: 'b.json', d: { criticName: 'C D' } };
  assert.equal(isUnresolvedGroup([a, b]), true);
  assert.equal(isUnresolvedGroup([a, { ...b, d: { ...b.d, wrongAttribution: true } }]), false);
  assert.equal(isUnresolvedGroup([a, { ...b, d: { ...b.d, duplicateTextOf: 'a.json' } }]), false);
  // A pointer outside the group settles nothing.
  assert.equal(isUnresolvedGroup([a, { ...b, d: { ...b.d, duplicateTextOf: 'z.json' } }]), true);
});
