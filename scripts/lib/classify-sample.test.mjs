// BRO-5292: sample cut points land on sentence boundaries, and a "truncated"
// verdict that only cites our own "[...]" marker is neutralized.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildClassifySample, sentenceBoundaries, applySampleMarkerCarveout, isSampled, SAMPLE_MARKER,
} = require('./classify-sample.js');

const CV = { head: 2500, tail: 800, window: 700, maxWindows: 2, fullLimit: 3300 };

// Sentences of uneven length so raw offsets fall mid-word.
function article(n, mention = 'Hamlet') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: 6 + (i * 7) % 13 }, (_, k) => `word${(i + k) % 17}`).join(' ');
    out.push(i % 9 === 4 ? `Mr. Smith says ${mention} ${words}.` : `Sentence ${i} has ${words}.`);
  }
  return out.join(' ');
}

const ENDS_SENTENCE = /[.!?]["'”’)\]]*$/;
const STARTS_SENTENCE = /^["'“‘(]?[A-Z0-9]/;

test('every sample part starts and ends on a sentence boundary', () => {
  for (const n of [80, 140, 260]) {
    const text = article(n);
    const parts = buildClassifySample('Hamlet', text, CV).split(SAMPLE_MARKER);
    assert.ok(parts.length >= 2, `n=${n}: sampled`);
    parts.forEach((p, k) => {
      if (k < parts.length - 1) assert.match(p, ENDS_SENTENCE, `n=${n} part ${k} ends: ${p.slice(-40)}`);
      if (k > 0) assert.match(p, STARTS_SENTENCE, `n=${n} part ${k} starts: ${p.slice(0, 40)}`);
      assert.ok(!/\bMr\.$/.test(p), 'never cut after an abbreviation');
      if (k > 0) assert.ok(text.includes(p), 'parts are verbatim slices');
    });
  }
});

test('raw cuts are kept with snap:false (A/B switch) and land mid-word here', () => {
  const text = article(140);
  const raw = buildClassifySample('Hamlet', text, { ...CV, snap: false }).split(SAMPLE_MARKER);
  assert.equal(raw[0].length, CV.head);
  assert.ok(raw.some((p, k) => k < raw.length - 1 && !ENDS_SENTENCE.test(p)), 'fixture would have been cut mid-sentence');
});

test('snapped sample stays close to the configured size and keeps the tail', () => {
  const text = article(260);
  const s = buildClassifySample('Hamlet', text, CV);
  assert.ok(s.length < CV.head + CV.tail + 2 * CV.window + 2000, `size ${s.length}`);
  assert.ok(s.endsWith(text.slice(-200)), 'tail kept');
  assert.ok(text.startsWith(s.split(SAMPLE_MARKER)[0]), 'head kept');
});

test('text with no sentence punctuation falls back to raw cuts', () => {
  const text = 'alpha '.repeat(2000) + 'omega';
  const s = buildClassifySample('Zzzzz Show', text, CV);
  assert.ok(s.endsWith('omega'));
  assert.ok(s.includes('[...]'));
});

test('short text passes through whole', () => {
  assert.equal(buildClassifySample('Hamlet', 'A short review. It is fine.', CV), 'A short review. It is fine.');
  assert.equal(isSampled('x'.repeat(3300), 3300), false);
  assert.equal(isSampled('x'.repeat(3301), 3300), true);
});

test('sentenceBoundaries skips abbreviations and initials', () => {
  const t = 'Mr. Sorkin wrote it. J. Smith agreed! Then "it ended." Fine';
  const bs = sentenceBoundaries(t, 0, t.length);
  const cuts = bs.map((b) => t.slice(0, b));
  assert.deepEqual(cuts, ['Mr. Sorkin wrote it.', 'Mr. Sorkin wrote it. J. Smith agreed!', 'Mr. Sorkin wrote it. J. Smith agreed! Then "it ended."']);
});

// Issue texts below are verbatim from the BRO-5243 WSJ verdicts (claude-haiku).
const LEOPOLDSTADT = [
  "Text is truncated mid-sentence in the middle section (ends with 'lends a fl' followed by '[...]')",
  "Byline attribution is incomplete at end ('Mr. Isherwood is the Journal's theater critic' confirms identity but is appended after the truncation)",
];

test('carve-out: truncated cleared when every truncation issue cites the marker', () => {
  const r = applySampleMarkerCarveout({ isValid: true, truncated: true, issues: ["Text is truncated mid-sentence in the middle section (indicated by '[...]')"] }, true);
  assert.equal(r.applied, true);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.issues, []);
});

test('carve-out: a truncation issue without the marker keeps the verdict', () => {
  const r = applySampleMarkerCarveout({ isValid: true, truncated: true, issues: LEOPOLDSTADT }, true);
  assert.equal(r.applied, false, 'second issue says "incomplete"/"truncation" without quoting [...]');
  assert.equal(r.truncated, true);
  const ending = applySampleMarkerCarveout({ isValid: false, truncated: true, issues: ['Review is cut off after the second paragraph', 'Marker [...] seen'] }, true);
  assert.equal(ending.applied, false);
});

test('carve-out: never applies to unsampled text (a quoted "[...]" in a review)', () => {
  const r = applySampleMarkerCarveout({ isValid: false, truncated: true, issues: ["Truncated at '[...]'"] }, false);
  assert.equal(r.applied, false);
  assert.equal(r.isValid, false);
});

test('carve-out: isValid restored only when nothing else stands against it', () => {
  const only = applySampleMarkerCarveout({ isValid: false, truncated: true, issues: ["Text is truncated mid-sentence ('rewriting Le[...]')"] }, true);
  assert.equal(only.isValid, true);
  const spliced = applySampleMarkerCarveout({
    isValid: false, truncated: true,
    issues: ["Text is truncated mid-sentence ('rewriting Le[...]')", 'A completely different review is spliced in'],
  }, true);
  assert.equal(spliced.applied, true);
  assert.equal(spliced.truncated, false);
  assert.equal(spliced.isValid, false, 'other issue remains, verdict kept');
  for (const flag of ['wrongArticle', 'wrongProduction', 'isFilmTv']) {
    const r = applySampleMarkerCarveout({ isValid: false, truncated: true, [flag]: true, issues: ['Truncated at [...]'] }, true);
    assert.equal(r.isValid, false, flag);
  }
  const unicode = applySampleMarkerCarveout({ isValid: true, truncated: true, issues: ['Breaks off mid-sentence at […]'] }, true);
  assert.equal(unicode.applied, true);
});

test('BRO-5292 review: article ending in its own "[…]" excerpt stub keeps the truncation verdict', () => {
  const issues = ["Text ends abruptly with 'I wasn't expecting […]', article is truncated"];
  const r = applySampleMarkerCarveout({ isValid: false, truncated: true, issues }, true, "x ".repeat(2000) + "I wasn't expecting […]");
  assert.equal(r.applied, false);
  assert.equal(r.truncated, true);
  assert.equal(r.isValid, false);
});

test('BRO-5292 review: carve-out does not restore isValid for a non-review articleType', () => {
  const r = applySampleMarkerCarveout({ isValid: false, truncated: true, articleType: 'preview', issues: ["Truncated at '[...]'"] }, true, 'plain text');
  assert.equal(r.applied, false);
  assert.equal(r.truncated, true);
  assert.equal(r.isValid, false);
});

test('BRO-5292 review: marker issue plus real mid-sentence tail keeps the verdict', () => {
  const r = applySampleMarkerCarveout({ isValid: false, truncated: true, issues: ['Text is truncated: ends at [...] and the final line stops mid-sentence ("the cast")'] }, true, 'x the cast');
  assert.equal(r.applied, false);
  assert.equal(r.isValid, false);
});

test('BRO-5292 review: a surviving "ends abruptly" issue keeps truncated', () => {
  const r = applySampleMarkerCarveout({ isValid: false, truncated: true, issues: ['Truncated mid-sentence at [...]', 'Article ends abruptly without a conclusion'] }, true, 'Fine ending.');
  assert.equal(r.applied, false);
  assert.equal(r.truncated, true);
});
