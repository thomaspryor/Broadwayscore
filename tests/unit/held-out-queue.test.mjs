// BRO-7999 R3: the held-out review queue, plus the two classifier fixes it exposed.
// Requires the real functions (CLAUDE.md §15); fixtures are synthetic, never real review text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { queueCandidate, humanRuled, hasScore, isRecentShow, sortQueue, QUEUE_RULES } = require('../../scripts/lib/held-out-queue.js');
const { heuristicClassify } = require('../../scripts/lib/non-review-patterns.js');
const { heuristicVerify } = require('../../scripts/lib/content-verifier.js');
const { decideHeldOutQueueAlert, KEYS } = require('../../scripts/lib/strict-audit-alerts.js');

const TODAY = new Date('2026-11-21T00:00:00Z');
const show = { id: 's', openingDate: '2026-11-03', cast: [{ name: 'Ann Lee' }, { name: 'Bob Ray' }, { name: 'Cy Doe' }] };
const base = () => ({ contentTier: 'complete', assignedScore: 70, fullText: 'Ann Lee and Bob Ray and Cy Doe shine.' });
const opts = (rule) => ({ today: TODAY, explain: () => rule });

test('queue: a complete, scored, cast-naming file held by a queue rule is a candidate', () => {
  const c = queueCandidate(base(), show, 'f.json', opts('cvWrongArticleHighConfidence'));
  assert.equal(c.rule, 'cvWrongArticleHighConfidence');
  assert.equal(c.signalCount, 3);
});

test('queue: wrongAttribution and includable files are out of scope', () => {
  assert.equal(queueCandidate(base(), show, 'f.json', opts('wrongAttribution')), null);
  assert.equal(queueCandidate(base(), show, 'f.json', opts(null)), null);
  assert.ok(!QUEUE_RULES.includes('wrongAttribution'));
});

test('queue: a person already ruled on it, so it is skipped', () => {
  for (const f of ['wrongProductionManualClear', 'wrongShowManualClear', 'wrongProductionOverride', 'allowCrossMarket', 'allowEarlyDate']) {
    assert.equal(queueCandidate({ ...base(), [f]: true }, show, 'f.json', opts('wrongShow')), null, f);
  }
  for (const f of ['rejectionReasoning', 'isNonReviewReason', 'wrongProductionReason', 'wrongShowReason']) {
    assert.equal(humanRuled({ [f]: 'manual: read it, stands' }), true, f);
    assert.equal(humanRuled({ [f]: 'CV-promoted (not a review): x' }), false, f);
  }
});

test('queue: needs min signals (default 3) and a recent show', () => {
  assert.equal(queueCandidate({ ...base(), contentTier: 'stub' }, show, 'f.json', opts('wrongShow')), null);
  assert.ok(queueCandidate({ ...base(), contentTier: 'stub' }, show, 'f.json', { ...opts('wrongShow'), minSignals: 2 }));
  assert.equal(queueCandidate(base(), { ...show, openingDate: '2026-01-01' }, 'f.json', opts('wrongShow')), null);
  assert.equal(isRecentShow({ openingDate: '2026-11-20' }, TODAY, 45), true);
  assert.equal(isRecentShow({}, TODAY, 45), false);
});

test('queue: score detection matches the rebuild precedence; rows sort rule-first', () => {
  assert.equal(hasScore({ llmScore: { score: null } }), false);
  assert.equal(hasScore({ llmScore: { score: 60 } }), true);
  const rows = sortQueue([
    { showId: 'b', file: 'x', rule: 'nonReview' }, { showId: 'a', file: 'y', rule: 'cvWrongArticleHighConfidence' },
  ]);
  assert.equal(rows[0].rule, 'cvWrongArticleHighConfidence');
});

test('alert: empty scan returns [], rows route, clean scan resolves, rows never carry text', () => {
  assert.deepEqual(decideHeldOutQueueAlert({ scanned: 0, rows: [] }), []);
  const [d] = decideHeldOutQueueAlert({ scanned: 100, rows: [{ showId: 's', file: 'f.json', rule: 'nonReview', signalCount: 3, fullText: 'SECRET REVIEW TEXT' }] });
  assert.equal(d.action, 'route');
  assert.equal(d.alert.severity, 'warning');
  assert.doesNotMatch(JSON.stringify(d), /SECRET REVIEW TEXT/);
  assert.match(d.alert.description, /s\/f\.json: held out by nonReview/);
  assert.equal(decideHeldOutQueueAlert({ scanned: 100, rows: [] })[0].action, 'resolve');
  assert.equal(d.alert.conditionKey || d.conditionKey || KEYS.heldOutQueue, KEYS.heldOutQueue);
});

// Root cause 1: obituary "aged N" beside a death sat deep in a review that recalls a composer's death.
test('non-review patterns: an age-and-death sentence deep in a review is not an obituary', () => {
  const text = 'Musical is a grim, gritty portrait of late-1980s New York set to a cracking rock soundtrack. Thursday, 15th October, by A Critic. Pictured: two actors in a show. JONATHAN Larson’s hit musical opened off-Broadway 30 years ago. Tragically, Larson died aged 35, the night before its first preview. The show follows a group of friends.';
  assert.equal(heuristicClassify(text), null);
});
test('non-review patterns: a real obituary lead still classifies', () => {
  const r = heuristicClassify('Veteran actor Jo Smith died aged 85 on Tuesday, the theatre confirmed. The funeral will be held next week and a tribute is planned.');
  assert.equal(r.isNonReview, true);
  assert.equal(r.type, 'obituary');
  assert.equal(heuristicClassify('Jo Smith has died. He was a beloved stage actor known for decades of work on Broadway and beyond.').type, 'obituary');
});

// Root cause 2: "to first look at" is a verb phrase in a critic's sentence, not a preview headline.
test('non-review patterns: "to first look at" is not a preview article, "First look at" still is', () => {
  const verb = 'Rope ** By A Critic November 3, 2026: Before getting to this revival, it’s important to first look at what preceded it on the thread culminating in the current play, which was written long ago by a British playwright.';
  assert.equal(heuristicClassify(verb), null);
  const head = 'First look at the new musical opening next month, with a sneak peek at the set. Casting details below for the whole company.';
  assert.equal(heuristicClassify(head).isNonReview, true);
});

// Root cause 3: curly apostrophes made a present title read as missing.
test('content verifier: a curly-apostrophe title in the body counts as present', () => {
  const body = 'Playwright Richard Nelson writes about a family. “We’ll See” is running at the Public Theater until Nov. 29. '.repeat(8);
  const r = heuristicVerify({ scrapedText: body, excerpt: '', showTitle: "We'll See", akaTitles: [] });
  assert.ok(!r.issues.some((i) => /not found in content/.test(i)), JSON.stringify(r.issues));
  const miss = heuristicVerify({ scrapedText: body, excerpt: '', showTitle: 'Totally Other Show', akaTitles: [] });
  assert.ok(miss.issues.some((i) => /not found in content/.test(i)));
});
