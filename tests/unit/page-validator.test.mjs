/**
 * Unit tests for page-validator year-mismatch detection
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/page-validator.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validatePageMatchesShow } = require('../../scripts/lib/page-validator');

// All tests use skipLlm to avoid external API calls
const SKIP_LLM = { skipLlm: true };

describe('Page Validator', () => {
  describe('year-mismatch detection', () => {
    it('rejects when heading year is 4+ years from opening year', async () => {
      const html = `<html><head><title>Review Roundup: BLOODY BLOODY ANDREW JACKSON 2010</title></head>
        <body><h1>Review Roundup: BLOODY BLOODY ANDREW JACKSON Opens on Broadway</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Blood/Love', { ...SKIP_LLM, openingYear: 2026 });
      assert.strictEqual(result.valid, false);
      assert.ok(result.reason.includes('year mismatch'));
    });

    it('rejects exact year in title tag even without heading year', async () => {
      const html = `<html><head><title>Review Roundup: WICKED Opens on Broadway 2003</title></head>
        <body><h1>Review Roundup: WICKED</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Wicked', { ...SKIP_LLM, openingYear: 2026 });
      assert.strictEqual(result.valid, false);
      assert.ok(result.reason.includes('year mismatch'));
    });

    it('accepts when heading year matches opening year', async () => {
      const html = `<html><head><title>Review Roundup: WICKED Opens on Broadway 2003</title></head>
        <body><h1>Review Roundup: WICKED</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Wicked', { ...SKIP_LLM, openingYear: 2003 });
      assert.strictEqual(result.valid, true);
    });

    it('accepts when heading year is within 3-year tolerance (revival)', async () => {
      const html = `<html><head><title>Review Roundup: CABARET at the Kit Kat Club 2024</title></head>
        <body><h1>Cabaret at the Kit Kat Club</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Cabaret at the Kit Kat Club', { ...SKIP_LLM, openingYear: 2023 });
      assert.strictEqual(result.valid, true);
    });

    it('accepts when multiple years in heading and one matches', async () => {
      const html = `<html><head><title>Review Roundup: LES MISERABLES Revival 2006 - Originally 1987</title></head>
        <body><h1>Les Miserables Revival</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Les Miserables', { ...SKIP_LLM, openingYear: 2006 });
      assert.strictEqual(result.valid, true);
    });

    it('falls through to word matching when no year in heading', async () => {
      const html = `<html><head><title>Review Roundup: HAMILTON Opens on Broadway</title></head>
        <body><h1>Review Roundup: HAMILTON</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Hamilton', { ...SKIP_LLM, openingYear: 2015 });
      assert.strictEqual(result.valid, true);
    });

    it('falls through to word matching when no openingYear provided', async () => {
      const html = `<html><head><title>Review Roundup: HAMILTON Opens on Broadway 2015</title></head>
        <body><h1>Review Roundup: HAMILTON</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Hamilton', SKIP_LLM);
      assert.strictEqual(result.valid, true);
    });
  });

  describe('word matching (existing behavior)', () => {
    it('rejects when title words do not match', async () => {
      const html = `<html><head><title>Review Roundup: BLOODY BLOODY ANDREW JACKSON</title></head>
        <body><h1>Review Roundup: BLOODY BLOODY ANDREW JACKSON Opens on Broadway</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Blood/Love', SKIP_LLM);
      assert.strictEqual(result.valid, false);
    });

    it('accepts when title words match', async () => {
      const html = `<html><head><title>Review: Hamilton on Broadway</title></head>
        <body><h1>Hamilton</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Hamilton', SKIP_LLM);
      assert.strictEqual(result.valid, true);
    });
  });

  describe('short-title partial-match guard', () => {
    // Regression: "Drunk Romeo & Juliet" (Off-Broadway Drunk Shakespeare parody)
    // was getting matched to the "Romeo + Juliet" Broadway 2024 roundup page
    // because 2/3 words matched and the LLM tiebreaker said YES.
    it('rejects "Drunk Romeo & Juliet" vs Romeo + Juliet roundup (the original bug)', async () => {
      const html = `<html><head><title>Romeo + Juliet on Broadway: Review Roundup</title></head>
        <body><h1>Romeo + Juliet Review Roundup</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Drunk Romeo & Juliet', { ...SKIP_LLM, openingYear: 2025 });
      assert.strictEqual(result.valid, false);
      assert.ok(result.reason.includes('short-title partial match'));
      assert.ok(result.reason.includes('drunk'));
    });

    it('rejects "Bad Cinderella" vs Cinderella roundup (same bug class)', async () => {
      const html = `<html><head><title>Cinderella Review Roundup</title></head>
        <body><h1>Cinderella</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Bad Cinderella', { ...SKIP_LLM, openingYear: 2023 });
      assert.strictEqual(result.valid, false);
    });

    it('still accepts "Romeo + Juliet" vs Romeo + Juliet roundup (no partial match)', async () => {
      const html = `<html><head><title>Romeo + Juliet Review Roundup</title></head>
        <body><h1>Romeo + Juliet</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'Romeo + Juliet', { ...SKIP_LLM, openingYear: 2024 });
      assert.strictEqual(result.valid, true);
    });

    it('still accepts "The Great Gatsby" full match', async () => {
      const html = `<html><head><title>The Great Gatsby Review Roundup</title></head>
        <body><h1>The Great Gatsby</h1></body></html>`;
      const result = await validatePageMatchesShow(html, 'The Great Gatsby', { ...SKIP_LLM, openingYear: 2024 });
      assert.strictEqual(result.valid, true);
    });
  });
});
