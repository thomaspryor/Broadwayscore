// BRO-7346: a HuffPost/Finkle First Nighter column reviews two or more shows,
// split by asterisk dividers. The scorer reads only the target section
// (BRO-7538); pull quotes and the rescore flag must follow the same section.
// Invented prose only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { pullQuoteSourceText, quoteOutsideTargetSection, hasUsableLlmQuote } = require('../../scripts/lib/pull-quote-guards.js');
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');
const { flagMultiShowRescore } = require('../../scripts/lib/multishow-rescore-flag.js');

const prose = 'The performers develop each scene carefully, and the staging lets the dialogue breathe. '.repeat(9);
const section = (title, verdict) => `${title} opens the evening. ${prose} ${verdict} The final scene of ${title} lands well.`;
const OWN = 'Invented Alpha is a sharp and welcome surprise for anyone who loves a chamber piece.';
const OTHER = 'Invented Beta is a lumbering revival that never once finds its comic footing at all.';
const fullText = `${section('Invented Alpha', OWN)}\n******************\n${section('Invented Beta', OTHER)}`;
const column = () => ({ outletId: 'huffpost', criticName: 'David Finkle', showTitle: 'Invented Alpha', fullText, contentTier: 'complete', llmScore: { score: 80 } });

test('a Finkle column yields only the target section as quote source', () => {
  const src = pullQuoteSourceText(column());
  assert.ok(src.includes(OWN));
  assert.ok(!src.includes(OTHER));
});

test('another outlet or a missing title keeps the whole text', () => {
  assert.equal(pullQuoteSourceText({ ...column(), outletId: 'wsj' }), fullText);
  assert.equal(pullQuoteSourceText({ ...column(), showTitle: undefined }), fullText);
});

test('a stored quote from the other show is not usable, so the extractor re-extracts', () => {
  assert.equal(quoteOutsideTargetSection(OTHER, column()), true);
  assert.equal(hasUsableLlmQuote({ ...column(), llmPullQuote: OTHER }), false);
  assert.equal(quoteOutsideTargetSection(OWN, column()), false);
  assert.equal(hasUsableLlmQuote({ ...column(), llmPullQuote: OWN }), true);
});

test('a review-field-edit refuses a quote from another show in the column', () => {
  const bad = applyReviewFieldEdit({ ...column(), llmPullQuote: null }, { field: 'llmPullQuote', oldValue: null, newValue: OTHER }, 'test');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /section of the multi-show column/);
  const good = applyReviewFieldEdit({ ...column(), llmPullQuote: OTHER }, { field: 'llmPullQuote', oldValue: OTHER, newValue: OWN }, 'test');
  assert.equal(good.ok, true, good.reason);
});

test('the extractor prompts and verifies on the section, but stamps rejections on the stored text', () => {
  const src = fs.readFileSync(new URL('../../scripts/extract-pull-quotes.js', import.meta.url), 'utf8');
  assert.match(src, /const sourceText = pullQuoteSourceText\(data\)/);
  assert.match(src, /buildUserPrompt\(sourceText,/);
  assert.doesNotMatch(src, /buildUserPrompt\(data\.fullText/);
  assert.match(src, /stampRejection\(filePath, storedText,/);
});

test('flag-multishow-column-rescore accepts a divider column and still refuses a plain review', () => {
  const d = column();
  assert.equal(flagMultiShowRescore(d, '2026-11-19T00:00:00Z').ok, true);
  assert.equal(d.needsRescore, true);
  const plain = { ...column(), fullText: section('Invented Alpha', OWN) + ' ' + prose.repeat(2) };
  assert.equal(flagMultiShowRescore(plain).ok, false);
  const noTitle = { ...column(), showTitle: undefined };
  assert.equal(flagMultiShowRescore(noTitle).ok, false);
});

test('a dash style difference between quote and text does not read as another show (no re-extract loop)', () => {
  const dashText = fullText.replace('Invented Alpha is a sharp', 'Invented Alpha -- is a sharp');
  const entry = { ...column(), fullText: dashText };
  const emDashQuote = 'Invented Alpha — is a sharp and welcome surprise for anyone who loves a chamber piece.';
  assert.equal(quoteOutsideTargetSection(emDashQuote, entry, 'Invented Alpha'), false);
  assert.equal(quoteOutsideTargetSection(OTHER, entry, 'Invented Alpha'), true);
});
