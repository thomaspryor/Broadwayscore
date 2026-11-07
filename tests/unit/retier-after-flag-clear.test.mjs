// BRO-5356: clearing wrongShow/wrongProduction left contentTier 'invalid'
// ('Wrong show'), so the rebuild kept the review off the site (spamalot-2023 and
// the-whos-tommy-2024 NYSR opening-night reviews). Invented placeholder text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { applyReviewFieldEdit, retierAfterFlagClear } = require('../../scripts/lib/review-field-edit.js');

const BODY = Array.from({ length: 40 }, (_, i) => `The revival is lively and the cast sings with real conviction, paragraph ${i}.`).join('\n\n')
  + '\n\nIt is the most purely enjoyable musical comedy on Broadway this season, and you should go.';
const flagged = (over = {}) => ({
  showId: 's', url: 'https://example.com/review', criticName: 'A Critic', fullText: BODY,
  contentTier: 'invalid', contentTierReason: 'Wrong show', incompleteReason: 'wrong_content',
  wrongShow: true, wrongShowManualClear: true, ...over,
});

test('clearing the last wrong-content flag recomputes a tier the flag caused', () => {
  const r = applyReviewFieldEdit(flagged(), { field: 'wrongShow', oldValue: true, newValue: false }, { fixId: 'bro-5356-x', at: '2026-10-14T00:00:00Z' });
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(r.record.contentTier, 'invalid');
  assert.equal(r.record.incompleteReason, null);
  assert.ok(r.sideEffectKeys.includes('contentTier'));
});

test('the tier stays invalid while another wrong-content flag is set, or when invalid for another reason', () => {
  assert.deepEqual(retierAfterFlagClear(flagged({ wrongShow: false, wrongProduction: true })), []);
  assert.deepEqual(retierAfterFlagClear(flagged({ wrongShow: false, contentTierReason: 'No text content' })), []);
  const stub = flagged({ wrongShow: false, fullText: '' });
  retierAfterFlagClear(stub);
  assert.notEqual(stub.contentTier, 'complete', 'no text is never complete');
});

test('reclassify-invalid-reviews --file retiers only the named rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retier-'));
  try {
    const rt = path.join(dir, 'data', 'review-texts');
    for (const [show, file] of [['a-show-2023', 'nysr--x.json'], ['b-show-2024', 'nysr--y.json']]) {
      fs.mkdirSync(path.join(rt, show), { recursive: true });
      fs.writeFileSync(path.join(rt, show, file), JSON.stringify(flagged({ showId: show, wrongShow: false }), null, 2));
    }
    const out = execFileSync('node', [path.join(ROOT, 'scripts/reclassify-invalid-reviews.js'), '--file=a-show-2023/nysr--x.json', '--apply'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /RETIERED a-show-2023\/nysr--x\.json: invalid -> complete/);
    const a = JSON.parse(fs.readFileSync(path.join(rt, 'a-show-2023', 'nysr--x.json'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(rt, 'b-show-2024', 'nysr--y.json'), 'utf8'));
    assert.equal(a.contentTier, 'complete');
    assert.equal(a.incompleteReason, null);
    assert.equal(b.contentTier, 'invalid', 'an unnamed row is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// BRO-5367: the same rule at write time, for every writer (rebuild auto-clears included).
const { retierStaleWrongContentTier } = require('../../scripts/lib/stale-wrong-content-tier.js');
const cleared = (over = {}) => flagged({ wrongShow: false, wrongShowManualClear: undefined, wrongProduction: false,
  contentTierReason: 'Wrong production', wrongProductionAutoCleared: 'rebuild: priorRuns/tourLegs covers publishDate', wrongProductionAutoClearedAt: '2026-09-29', ...over });

test('a rebuild-auto-cleared row is retiered; an absent flag with no clear evidence is not (BRO-4432 contamination signal)', () => {
  const r = cleared(); assert.ok(retierStaleWrongContentTier(r).length); assert.notEqual(r.contentTier, 'invalid');
  const noEvidence = cleared({ wrongProductionAutoCleared: undefined, wrongProductionAutoClearedAt: undefined });
  assert.deepEqual(retierStaleWrongContentTier(noEvidence), []);
  assert.equal(noEvidence.contentTier, 'invalid');
});

test('rejected or garbage rows stay invalid', () => {
  assert.deepEqual(retierStaleWrongContentTier(cleared({ rejectionReason: 'wrong_show' })), []);
  assert.deepEqual(retierStaleWrongContentTier(cleared({ incompleteReason: 'scraper_garbage' })), []);
  assert.deepEqual(retierStaleWrongContentTier(cleared({ wrongProduction: 'yes' })), [], 'a truthy flag still blocks');
});

test('safeWriteReview retiers a cleared row it writes, but never a locked file without force', () => {
  const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retier-write-'));
  try {
    const fp = path.join(dir, 'a-show-2025', 'standard--a-critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    safeWriteReview(fp, cleared({ showId: 'a-show-2025' }));
    assert.notEqual(JSON.parse(fs.readFileSync(fp, 'utf8')).contentTier, 'invalid');
    const lp = path.join(dir, 'a-show-2025', 'times--b-critic.json');
    fs.writeFileSync(lp, JSON.stringify(cleared({ showId: 'a-show-2025', _locked: true, url: 'https://example.com/b' })));
    safeWriteReview(lp, cleared({ showId: 'a-show-2025', _locked: true, url: 'https://example.com/b' }));
    assert.equal(JSON.parse(fs.readFileSync(lp, 'utf8')).contentTier, 'invalid', 'locked, no force');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
