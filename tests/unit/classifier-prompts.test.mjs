/**
 * Behavior-level integration test for opera-aware classifier prompt builders.
 *
 * Background (ship-check P1-B, 2026-05-17): the original
 * tests/unit/opera-prompt-context.test.mjs only asserts that the context
 * strings exist and contain expected words. It does NOT verify that the
 * classifier's buildUserPrompt actually injects the context. A regression
 * that drops the `isOpera ? ... : ...` branch from buildUserPrompt would
 * pass all context-only tests.
 *
 * This file tests the PURE prompt builders in scripts/lib/classifier-prompts.js,
 * which the production classifiers now delegate to. Tests verify the
 * Broadway vs opera branching is correct AND that the year-mismatch
 * WRONG_PRODUCTION signal survives the opera-aware tightening.
 *
 * See Notion 363637c5-416f-81cc-8240-c48df8b4cfd2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWrongProductionUserPrompt,
  buildWrongShowUserPrompt,
} from '../../scripts/lib/classifier-prompts.js';

// ============================================================
// Wrong-Production prompt builder
// ============================================================

test('wrong-production: opera show injects opera context block', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { type: 'opera', title: 'Eugene Onegin' },
    result: {
      showId: 'eugene-onegin-off-broadway-2026',
      showYear: 2026,
      outlet: 'Operawire',
      criticName: 'David Salazar',
      publishDate: '2026-04-21',
      signals: ['publishDate-mismatch'],
    },
    reviewData: { fullText: 'Tchaikovsky\'s Eugene Onegin at the Met...' },
    revivals: [],
  });
  assert.match(prompt, /OPERA CONTEXT/);
  assert.match(prompt, /Metropolitan Opera run opening: 2026/);
  assert.match(prompt, /WRONG_PRODUCTION/);
  assert.match(prompt, /PRIOR MET PRODUCTIONS OF THIS WORK/);
  assert.doesNotMatch(prompt, /Broadway opening:/);
  assert.doesNotMatch(prompt, /OTHER BROADWAY PRODUCTIONS/);
});

test('wrong-production: non-opera Broadway show does NOT inject opera context', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { type: 'musical', title: 'Hamilton' },
    result: {
      showId: 'hamilton-2015',
      showYear: 2015,
      outlet: 'The New York Times',
      criticName: 'Ben Brantley',
      publishDate: '2015-08-06',
      signals: [],
    },
    reviewData: { fullText: 'Lin-Manuel Miranda revolutionary musical...' },
    revivals: [],
  });
  assert.doesNotMatch(prompt, /OPERA CONTEXT/);
  assert.doesNotMatch(prompt, /Metropolitan Opera/);
  assert.match(prompt, /Broadway opening: 2015/);
  assert.match(prompt, /OTHER PRODUCTIONS OF THIS SHOW/);
});

test('wrong-production: West End show is labelled West End, not Broadway (Phantom 1986 FP fix)', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { type: 'musical', title: 'The Phantom of the Opera', market: 'west-end' },
    result: {
      showId: 'the-phantom-of-the-opera-west-end-1986',
      showYear: 1986,
      outlet: 'The Guardian',
      criticName: 'Michael Billington',
      publishDate: '1986-10-10',
      signals: [],
    },
    reviewData: { fullText: 'The original West End premiere at Her Majesty\'s Theatre...' },
    revivals: [],
  });
  // Must name the correct market so a correctly-filed WE review is not read as a mismatch
  assert.match(prompt, /West End opening: 1986/);
  assert.doesNotMatch(prompt, /Broadway opening:/);
});

test('wrong-production: opera context retains year-mismatch WRONG_PRODUCTION signal (the Waleson 2018 case)', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { type: 'opera', title: 'La Traviata' },
    result: {
      showId: 'la-traviata-off-broadway-2026',
      showYear: 2026,
      outlet: 'The Wall Street Journal',
      criticName: 'Heidi Waleson',
      publishDate: '2018-12-05',
      signals: ['publishDate predates filed production opening by 7+ years'],
    },
    reviewData: { fullText: 'The Met new Michael Mayer staging of La Traviata...' },
    revivals: [],
  });
  // The 2018 publish date must surface in the prompt
  assert.match(prompt, /2018-12-05/);
  // The opera context tells the LLM to treat year-mismatched publishDate as a
  // WRONG_PRODUCTION signal — this language must be preserved
  assert.match(prompt, /publishDate.*before.*opening date|year mismatch|year-mismatched/i);
  assert.match(prompt, /WRONG_PRODUCTION/);
  // Discredited "Be lenient" wording must NOT appear (ship-check P1-A)
  assert.doesNotMatch(prompt, /\bBe lenient\b/);
});

test('wrong-production: handles null show gracefully (orphaned review)', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: null,
    result: {
      showId: 'unknown-show-2026',
      showTitle: 'Unknown',
      showYear: 2026,
      outlet: 'Variety',
      signals: [],
    },
    reviewData: { fullText: 'A review.' },
    revivals: [],
  });
  assert.doesNotMatch(prompt, /OPERA CONTEXT/);
  assert.match(prompt, /Broadway opening: 2026/);
});

test('wrong-production: handles missing reviewData fields without crashing', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { type: 'opera', title: 'Tristan und Isolde' },
    result: {
      showId: 'tristan-und-isolde-off-broadway-2026',
      showYear: 2026,
      signals: [],
    },
    reviewData: {},
    revivals: [],
  });
  assert.match(prompt, /OPERA CONTEXT/);
  assert.match(prompt, /\(no text available\)/);
});

// ============================================================
// Wrong-Show prompt builder
// ============================================================

test('wrong-show: opera show injects opera context block', () => {
  const prompt = buildWrongShowUserPrompt({
    show: { type: 'opera' },
    showTitle: 'La Traviata',
    showId: 'la-traviata-off-broadway-2026',
    text: 'Verdi La Traviata at the Met...',
  });
  assert.match(prompt, /OPERA CONTEXT/);
  assert.match(prompt, /Metropolitan Opera House/);
  // Genuine wrong-show signal preserved
  assert.match(prompt, /WRONG_SHOW/);
  assert.match(prompt, /(different opera|different show entirely|different title)/i);
});

test('wrong-show: non-opera Broadway show does NOT inject opera context', () => {
  const prompt = buildWrongShowUserPrompt({
    show: { type: 'play' },
    showTitle: 'The Lehman Trilogy',
    showId: 'the-lehman-trilogy-2022',
    text: 'A sweeping three-hander.',
  });
  assert.doesNotMatch(prompt, /OPERA CONTEXT/);
  assert.doesNotMatch(prompt, /Metropolitan Opera/);
});

test('wrong-show: handles null show.type gracefully', () => {
  const prompt = buildWrongShowUserPrompt({
    show: { type: null },
    showTitle: 'Some Show',
    showId: 'some-show-2026',
    text: 'A review.',
  });
  assert.doesNotMatch(prompt, /OPERA CONTEXT/);
});

test('wrong-show: truncates long text at 2000 chars', () => {
  const longText = 'a'.repeat(5000);
  const prompt = buildWrongShowUserPrompt({
    show: { type: 'musical' },
    showTitle: 'Test',
    showId: 'test-2026',
    text: longText,
  });
  assert.match(prompt, /first 2000 chars/);
});
