// LIVE-DATA-LANE: reads data/review-texts (private). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-4318 VERIFY: every "sided with LLM" adjudication that sat outside its stored rating's band
// (data/audit/bro-4318-adjudication-dispositions.json) is resolved: the rating corrected, the
// rating cleared, or the adjudication cleared so the rating stands. Reads the private review
// texts when they are present (REVIEW_TEXTS_DIR, data/review-texts, or a sibling
// broadway-review-texts checkout); without them only the committed list is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { adjudicationStarConflict, dispositionResolved, DISPOSITIONS } = require('./lib/adjudication-star-conflict.js');
const { verifiedRatingError } = require('./lib/verified-original-score.js');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = JSON.parse(fs.readFileSync(path.join(repo, 'data/audit/bro-4318-adjudication-dispositions.json'), 'utf8'));

function reviewTextsDir() {
  for (const d of [process.env.REVIEW_TEXTS_DIR, path.join(repo, 'data/review-texts'), path.join(repo, '..', 'broadway-review-texts')]) {
    if (d && fs.existsSync(path.join(d, list.entries[0].file.split('/')[0]))) return d;
  }
  return null;
}

test('the disposition list is complete and carries no review text', () => {
  assert.equal(list.entries.length, 23);
  assert.equal(new Set(list.entries.map((e) => e.file)).size, list.entries.length, 'no duplicate files');
  for (const e of list.entries) {
    assert.match(e.file, /^[a-z0-9-]+\/[a-z0-9-]+--[a-z0-9-]+\.json$/, e.file);
    assert.ok(DISPOSITIONS.includes(e.disposition), `${e.file}: ${e.disposition}`);
    assert.ok(typeof e.evidence === 'string' && e.evidence.length < 300, `${e.file}: short evidence, no quoted review`);
    if (e.disposition === 'star-cleared') assert.equal(e.to, null, e.file);
    if (e.disposition === 'star-corrected') assert.equal(verifiedRatingError({ outletId: e.file.split('/')[1].split('--')[0] }, e.to), null, `${e.file}: ${e.to} parses`);
    if (e.disposition === 'adjudication-cleared') assert.equal(e.to, e.from, `${e.file}: the stored rating stands`);
  }
});

test('the conflict predicate flags a disputed star and passes a resolved one', () => {
  const rec = { outletId: 'ew', originalScore: 'C-', originalScoreSource: 'letter-grade', adjudicatedScore: 25, adjudicationNote: 'Auto-adjudicated (high confidence, sided with llm): a pan.' };
  assert.ok(adjudicationStarConflict(rec));
  assert.equal(adjudicationStarConflict({ ...rec, adjudicatedScore: 50 }), null, 'inside the band');
  assert.equal(adjudicationStarConflict({ ...rec, adjudicationNote: 'Auto-adjudicated (high confidence, sided with originalScore): ok' }), null);
  assert.equal(dispositionResolved(rec, 'adjudication-cleared', 'C-').ok, false);
  assert.equal(dispositionResolved({ ...rec, adjudicatedScore: null, adjudicationNote: null }, 'adjudication-cleared', 'C-').ok, true);
});

test('every listed review is in its resolved state', (t) => {
  const dir = reviewTextsDir();
  if (!dir) { t.skip('review texts not present in this checkout'); return; }
  const unresolved = [];
  for (const e of list.entries) {
    const p = path.join(dir, e.file);
    const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    const r = dispositionResolved(data, e.disposition, e.to);
    if (!r.ok) unresolved.push(`${e.file} (${e.disposition}): ${r.reason}`);
  }
  assert.deepEqual(unresolved, [], `${unresolved.length} unresolved:\n${unresolved.join('\n')}`);
});
