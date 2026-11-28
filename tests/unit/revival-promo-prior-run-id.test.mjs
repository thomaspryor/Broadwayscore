/**
 * BRO-4888 (London Into the Woods + Evita pages, revival promo): acceptance
 * tests for the prevention items. Per CLAUDE.md rule 15 these require() the
 * real helpers.
 *
 *  - the FT Hemming/Bano duplicate direction: once Hemming (ft.com url, the
 *    5-star review, 95) is canonical and the Bano copy points at it, the
 *    direction heal must leave it alone;
 *  - a stale isRoundupArticle flag on an outlet's own per-article url is
 *    reported (read-only audit), a real roundup url is not;
 *  - the same-text-different-byline detector reports a different-url pair and
 *    stays quiet for the same-url case (dedupe-same-url-bylines.js owns that),
 *    for already-pointered files and for wire services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDirectionFlips } = require('../../scripts/lib/duplicate-direction-heal.js');
const { findSameTextDifferentByline, findOwnDomainRoundupFlags } = require('../../scripts/lib/review-pair-anomalies.js');

const BODY = 'Into the Woods is one of Stephen Sondheim’s most popular musicals, but this Bridge Theatre staging is a spellbinding thing, tender and sharp by turns. '.repeat(30);
const FT_URL = 'https://www.ft.com/content/9da2a948-bb09-4c48-9cf3-969d00f35e62';
const REGISTRY = { outlets: { telegraph: { domain: 'telegraph.co.uk' }, financialtimes: { domain: 'ft.com' }, thestage: { domain: 'thestage.co.uk' } } };

test('FT pair: after the fix (Hemming canonical, Bano the duplicate) the direction heal changes nothing', () => {
  const records = [
    { file: 'financialtimes--sarah-hemming.json', data: { criticName: 'Sarah Hemming', outletId: 'financialtimes', url: FT_URL, fullText: BODY, assignedScore: 95 } },
    { file: 'financialtimes--tim-bano.json', data: { criticName: 'Tim Bano', outletId: 'financialtimes', url: FT_URL, fullText: BODY, assignedScore: 89, duplicateOf: 'financialtimes--sarah-hemming.json' } },
  ];
  assert.deepEqual(findDirectionFlips(records), []);
});

test('stale roundup flag: reported on the outlet\'s own per-article url, not on a roundup url', () => {
  const stale = { file: 'telegraph--dominic-cavendish.json', data: { outletId: 'telegraph', isRoundupArticle: true, roundupArticleReason: 'auto: URL matches LBO Review-Round-Up page pattern', url: 'https://www.telegraph.co.uk/theatre/what-to-see/into-the-woods-review-bridge-theatre/', fullText: BODY } };
  const real = { file: 'thestage--roundup.json', data: { outletId: 'thestage', isRoundupArticle: true, url: 'https://www.thestage.co.uk/review-round-ups/into-the-woods-bridge-theatre', fullText: BODY } };
  const found = findOwnDomainRoundupFlags([stale, real], REGISTRY);
  assert.deepEqual(found.map((f) => f.file), ['telegraph--dominic-cavendish.json']);
});

test('stale roundup flag: needs real text, a registered own domain and the flag itself', () => {
  const base = { outletId: 'telegraph', isRoundupArticle: true, url: 'https://www.telegraph.co.uk/theatre/what-to-see/x-review/', fullText: BODY };
  const rec = (d) => [{ file: 'a.json', data: { ...base, ...d } }];
  assert.equal(findOwnDomainRoundupFlags(rec({ fullText: 'short' }), REGISTRY).length, 0);
  assert.equal(findOwnDomainRoundupFlags(rec({ isRoundupArticle: false }), REGISTRY).length, 0);
  assert.equal(findOwnDomainRoundupFlags(rec({ url: 'https://londonboxoffice.co.uk/news/post/x' }), REGISTRY).length, 0, 'not the outlet\'s own domain');
  assert.equal(findOwnDomainRoundupFlags(rec({ outletId: 'unregistered-outlet' }), REGISTRY).length, 0, 'unknown outlet cannot be judged');
  assert.equal(findOwnDomainRoundupFlags(rec({}), REGISTRY).length, 1);
});

test('same text, different byline: reported for a different-url pair of one outlet', () => {
  const a = { file: 'timeout--a-writer.json', data: { outletId: 'timeout', criticName: 'Alice Writer', url: 'https://www.timeout.com/london/theatre/into-the-woods-review', fullText: BODY } };
  const b = { file: 'timeout--b-writer.json', data: { outletId: 'timeout', criticName: 'Bob Writer', url: 'https://www.timeout.com/london/theatre/into-the-woods-5', fullText: BODY } };
  const found = findSameTextDifferentByline([a, b]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].files.sort(), ['timeout--a-writer.json', 'timeout--b-writer.json']);
});

test('same text, different byline: quiet for same url, pointered files, equal names, wire services and different outlets', () => {
  const mk = (file, over) => ({ file, data: { outletId: 'timeout', criticName: 'Alice Writer', url: 'https://example.com/a', fullText: BODY, ...over } });
  // same url: dedupe-same-url-bylines.js owns it
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { criticName: 'Bob Writer' })]).length, 0);
  // already pointered
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { criticName: 'Bob Writer', url: 'https://example.com/b', duplicateOf: 'a.json' })]).length, 0);
  // same name
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { url: 'https://example.com/b' })]).length, 0);
  // wire service
  assert.equal(findSameTextDifferentByline([mk('a.json', { outletId: 'ap' }), mk('b.json', { outletId: 'ap', criticName: 'Bob Writer', url: 'https://example.com/b' })]).length, 0);
  // different outlets
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { outletId: 'standard', criticName: 'Bob Writer', url: 'https://example.com/b' })]).length, 0);
  // Unknown byline is the direction heal's case
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { criticName: 'Unknown', url: 'https://example.com/b' })]).length, 0);
  // much shorter second text
  assert.equal(findSameTextDifferentByline([mk('a.json', {}), mk('b.json', { criticName: 'Bob Writer', url: 'https://example.com/b', fullText: BODY.slice(0, Math.floor(BODY.length * 0.6)) })]).length, 0);
});
