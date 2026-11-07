/**
 * stripInlineMarkdown — synopses/consensus arrive from LLM + press-copy
 * sources with raw markdown (*Gloria*, **bold**, [links](url)) that leaked
 * onto guide/browse/show pages and into JSON-LD (user screenshot 2026-07-14).
 * The helper is applied once at the ComputedShow boundary (engine.ts) and in
 * data-guides getCriticConsensus; this locks the stripping contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInlineMarkdown } from '../../src/lib/formatting';

test('strips single-asterisk emphasis (the *Gloria* bug)', () => {
  assert.equal(
    stripInlineMarkdown('*Gloria* is a play about a cut-throat magazine.'),
    'Gloria is a play about a cut-throat magazine.'
  );
});

test('strips bold, links, and inline code', () => {
  assert.equal(
    stripInlineMarkdown('**Bold** and [linked](https://x.com) text with `code`.'),
    'Bold and linked text with code.'
  );
});

test('leaves clean prose and lone asterisks untouched', () => {
  assert.equal(
    stripInlineMarkdown('No markdown here — 2h 45m.'),
    'No markdown here — 2h 45m.'
  );
  assert.equal(
    stripInlineMarkdown('Songs marked by *; see the soundtrack note'),
    'Songs marked by *; see the soundtrack note'
  );
});

test('passes through null/undefined/empty unchanged', () => {
  assert.equal(stripInlineMarkdown(null), null);
  assert.equal(stripInlineMarkdown(undefined), undefined);
  assert.equal(stripInlineMarkdown(''), '');
});

test('emphasis does not span newlines (footnote asterisks on separate lines)', () => {
  const twoLines = 'first line ends with *\nsecond line starts with * too';
  assert.equal(stripInlineMarkdown(twoLines), twoLines);
});
