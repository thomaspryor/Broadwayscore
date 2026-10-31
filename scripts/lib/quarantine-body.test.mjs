// BRO-2788: a body set aside as wrong content must not read as "never scraped".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { quarantineBody, describeTextState, countWords } = require('./quarantine-body');
const { classifyContentTier } = require('./content-quality');

const BODY = 'The Story at the Olivier is a taut, unsettling evening. '.repeat(70);

test('quarantine keeps the word count of the set-aside body', () => {
  const d = { fullText: BODY, textWordCount: countWords(BODY), wrongProduction: true };
  assert.equal(quarantineBody(d), true);
  assert.equal(d.fullText, null);
  assert.equal(d.wrongFullText, BODY);
  assert.equal(d.quarantinedWordCount, countWords(BODY));
  assert.ok(d.quarantinedWordCount > 600);
  // the fetch-time count is not touched
  assert.equal(d.textWordCount, countWords(BODY));
});

test('after tier reclassification (wordCount -> 0) the record still reads as quarantined, not unscraped', () => {
  const d = { fullText: BODY, wrongProduction: true };
  quarantineBody(d);
  d.wordCount = classifyContentTier(d).wordCount; // what collect-review-texts does next
  assert.equal(d.wordCount, 0);
  assert.deepEqual(describeTextState(d), { state: 'quarantined', words: countWords(BODY) });
});

test('describeTextState: present, quarantined without a stamp (older records), none', () => {
  assert.equal(describeTextState({ fullText: BODY }).state, 'present');
  assert.deepEqual(describeTextState({ fullText: null, wrongFullText: 'one two three' }), { state: 'quarantined', words: 3 });
  assert.deepEqual(describeTextState({ fullText: null }), { state: 'none', words: 0 });
  assert.deepEqual(describeTextState({ fullText: '', wordCount: 0 }), { state: 'none', words: 0 });
});

test('nothing to quarantine leaves the record alone', () => {
  const d = { fullText: null, wrongFullText: 'kept' };
  assert.equal(quarantineBody(d), false);
  assert.equal(d.wrongFullText, 'kept');
  assert.equal(d.quarantinedWordCount, undefined);
});

// Prevention: every script sets a body aside through quarantineBody(), so the
// word count is never lost again by a hand-rolled move.
test('no script hand-rolls the fullText -> wrongFullText move', () => {
  const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'one-off' || e.name === 'migrations') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(c?js|ts)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      if (p.endsWith(path.join('lib', 'quarantine-body.js'))) continue;
      const src = fs.readFileSync(p, 'utf8');
      // Any hand-rolled move: same or another variable, assignment or object
      // literal (BRO-5261 S11 widened it from the same-variable form only).
      if (/\bwrongFullText\s*[:=]\s*[A-Za-z_$][\w$.\[\]'"]*\.fullText\b/.test(src)) offenders.push(path.relative(scriptsDir, p));
    }
  };
  walk(scriptsDir);
  assert.deepEqual(offenders, [], `use quarantineBody() from scripts/lib/quarantine-body.js in: ${offenders.join(', ')}`);
});

// BRO-2851: restoring a body whose wrong-content flag was released.
const { releasedBodyRestoreVerdict, restoreReleasedBody } = require('./quarantine-body');
const REVIEW = 'Kimberly Belflower’s play puts Proctor, Salem and 1690s, 1950s and 2010s misogyny under the microscope at the Royal Court. '.repeat(12);
const deps = { isGarbage: (t) => /cookie consent/i.test(t), sameArticle: (a, b) => b.includes(a.slice(0, 80)) };
const released = (over) => ({ wrongFullText: REVIEW, fullText: REVIEW.slice(0, 300), wrongProduction: false, wrongProductionOverride: true, ...over });

test('released + shorter copy of the same article: restore', () => {
  const v = releasedBodyRestoreVerdict(released(), deps);
  assert.equal(v.ok, true, v.reason);
});

test('refuses: no explicit release (script auto-clear only), still flagged, garbage, different article, not much shorter, locked', () => {
  assert.equal(releasedBodyRestoreVerdict(released({ wrongProductionOverride: undefined, wrongProductionAutoCleared: 'rebuild: dateless-revival hold released' }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ wrongProduction: true }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ wrongFullText: 'Cookie consent. ' + REVIEW }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: 'A different article entirely about a film. '.repeat(10) }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: REVIEW.slice(0, REVIEW.length - 50) }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ _locked: true }), deps).ok, false);
  // quarantines that set none of the exclusion flags, under an unrelated release
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, contentMismatchNote: 'names another show' }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, incompleteReason: 'non_review' }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, suspectedLlmHallucination: true }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, contentVerification: { wrongArticle: true } }), deps).ok, false);
  // BRO-5261 S11: discardWrongPageFill and a top-level wrongArticle set no exclusion flag above
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, incompleteReason: 'wrong_page_served' }), deps).ok, false);
  assert.equal(releasedBodyRestoreVerdict(released({ fullText: null, wrongArticle: true }), deps).ok, false);
});

test('released with no live text: restore, and the tier is re-derived from the full body', () => {
  const d = released({ fullText: null, quarantinedWordCount: 120, incompleteReason: 'partial_text' });
  assert.equal(releasedBodyRestoreVerdict(d, deps).ok, true);
  restoreReleasedBody(d, () => ({ contentTier: 'complete', tierReason: 'Full review text', wordCount: 240 }), '2026-10-13T00:00:00Z');
  assert.equal(d.fullText, REVIEW);
  assert.equal(d.wrongFullText, REVIEW, 'audit copy kept');
  assert.ok(d.releasedBodyRestoredAt, 'stamped as released');
  assert.equal(d.quarantinedWordCount, null);
  assert.equal(d.contentTier, 'complete');
  assert.equal(d.incompleteReason, null);
  assert.equal(describeTextState(d).state, 'present');
  quarantineBody(d);
  assert.equal(d.releasedBodyRestoredAt, null, 'a later verdict clears the release stamp');
});

test('quarantineBody: a whitespace-only body is emptied and an older quarantined body is left alone (BRO-5261 S11)', () => {
  const d = { fullText: '  \n ', wrongFullText: 'older body' };
  assert.equal(quarantineBody(d), false);
  assert.equal(d.fullText, null);
  assert.equal(d.wrongFullText, 'older body');
});
