// BRO-6924: "Tosca - English National Opera" tokenised to tosca/english/national/opera,
// so Bachtrack slugs like "...-polish-national-opera-warsaw" passed the 2-hit rule
// with no "tosca" and landed in the ENO folder three times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { operaTitleWords, operaTitleMatch } = require('../../scripts/lib/site-search-discovery.js');
const eno = operaTitleWords('Tosca - English National Opera');

test('a labelled title needs its head word, not just label words', () => {
  assert.equal(operaTitleMatch('kolomiiets-mothers-of-kherson-polish-national-opera-warsaw-october-2026', eno, 2), false);
  assert.equal(operaTitleMatch('shostakovich-cherry-town-dutch-national-opera', eno, 1), false);
  assert.equal(operaTitleMatch('tosca-miskimmon-glassberg-fanyo-english-national-opera-london-october-2026', eno, 2), true);
});

test('an unlabelled title keeps the plain hit rule', () => {
  const w = operaTitleWords('Tristan und Isolde');
  assert.equal(w.headWords, undefined);
  assert.equal(operaTitleMatch('tristan-isolde-metropolitan-opera', w, 2), true);
  assert.equal(operaTitleMatch('tosca-met-opera', operaTitleWords('Tosca'), 1), true);
});

test('a hyphenated title is not a labelled one', () => {
  assert.equal(operaTitleWords('Spider-Man').headWords, undefined);
});

test('DISABLE_OPERA_HEAD_WORD_MATCH restores the old rule', () => {
  process.env.DISABLE_OPERA_HEAD_WORD_MATCH = 'true';
  try {
    assert.equal(operaTitleMatch('polish-national-opera-warsaw', eno, 2), true);
  } finally { delete process.env.DISABLE_OPERA_HEAD_WORD_MATCH; }
});
