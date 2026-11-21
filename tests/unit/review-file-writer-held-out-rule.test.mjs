// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7999 R1: BRO-7817's census ingest printed "Skipped: no-changes" for URLs we already held but
// the site excluded (wrongProduction, wrongShow, CV wrong-article), so held-out reviews read as live.
// The writer result now carries heldOutRule (explainExclusion on the final record; the in-memory
// record on a dry run) and ingest-outcome reports { outcome: 'held-out' } to the fix runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile, classifyHeldOut } = require('../../scripts/lib/review-file-writer');
const o = require('../../scripts/lib/ingest-outcome.js');

const showId = 'held-out-rule-fixture';
const input = {
  outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
  url: 'https://variety.com/legit/reviews/held-out-rule-fixture', source: 'held-out-rule-test',
};
const fullText = 'The revival opens with a jolt and never lets up; the cast sings beautifully and the staging is sharp. '.repeat(30);

function fixture(t, stored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-out-rule-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, showId));
  const filepath = path.join(dir, showId, 'variety--naveen-kumar.json');
  fs.writeFileSync(filepath, JSON.stringify({ ...input, showId, sources: [input.source], fullText, publishDate: '2024-04-01', ...stored }));
  return { dir, filepath };
}

test('an unchanged re-ingest of a held-out record names the rule (the BRO-7817 case)', (t) => {
  const { dir } = fixture(t, { wrongShow: true, wrongShowReason: 'fixture' });
  const r = createOrMergeReviewFile(showId, { ...input }, { reviewTextsDir: dir });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'no-changes');
  assert.equal(r.heldOutRule, 'wrongShow');
});

test('an included record gets no heldOutRule key (result shapes stay as callers compare them)', (t) => {
  const { dir } = fixture(t, {});
  const r = createOrMergeReviewFile(showId, { ...input }, { reviewTextsDir: dir });
  assert.equal(Object.hasOwn(r, 'heldOutRule'), false);
});

test('a dry-run merge classifies the in-memory record and writes nothing', (t) => {
  const { dir, filepath } = fixture(t, { wrongShow: true, wrongShowReason: 'fixture' });
  const before = fs.readFileSync(filepath, 'utf8');
  const r = createOrMergeReviewFile(showId, { ...input, source: 'a-second-source' }, { reviewTextsDir: dir, dryRun: true });
  assert.equal(r.action, 'updated');
  assert.equal(r.heldOutRule, 'wrongShow');
  assert.equal(fs.readFileSync(filepath, 'utf8'), before);
});

test('the attached record never serialises into a result', (t) => {
  const { dir } = fixture(t, {});
  const r = createOrMergeReviewFile(showId, { ...input, source: 'a-second-source' }, { reviewTextsDir: dir, dryRun: true });
  assert.ok(r.record, 'record is reachable for classification');
  assert.equal(Object.keys(r).includes('record'), false);
  assert.equal(JSON.stringify(r).includes('fullText'), false);
});

test('a guard refusal gets no heldOutRule (nothing new is on file)', () => {
  const r = { action: 'skipped', reason: 'write-guard-refused', filepath: '/nonexistent' };
  assert.equal(classifyHeldOut(showId, '/nonexistent/x.json'), undefined, 'unreadable file: unknown, never a throw');
  assert.equal(r.heldOutRule, undefined);
});

test('ingest-outcome: a held-out note never overwrites a failure already reported (Codex ship-check)', () => {
  const f = o.newOutcomeFile();
  try {
    o.writeIngestOutcome({ outcome: 'retry-stub', reason: 'fetch failed' }, { [o.ENV]: f });
    o.writeIngestOutcome({ outcome: 'held-out', rule: 'wrongShow' }, { [o.ENV]: f });
    assert.equal(o.readIngestOutcome(f).outcome, 'retry-stub');
  } finally { o.removeOutcomeFile(f); }
});

test('ingest-outcome: held-out is a note for the fix runner, never a failed recovery', () => {
  assert.equal(o.stubProblem({ outcome: 'held-out', rule: 'wrongShow' }), null);
  assert.match(o.heldOutNote({ outcome: 'held-out', rule: 'wrongShow' }) || '', /held out of the site by wrongShow/);
  assert.equal(o.heldOutNote({ outcome: 'retry-stub' }), null);
  assert.equal(o.heldOutNote(null), null);
});

test('a fix plan whose ingest stays held out after the last action fails; one a later action cleared passes', (t) => {
  const { dir, filepath } = fixture(t, { wrongShow: true, wrongShowReason: 'fixture' });
  const results = [{ action: 'run-script', ok: true, heldOut: { showId, filepath } }, { action: 'review-file-op', ok: true }];
  const classify = (sid, fp) => classifyHeldOut(sid, fp);
  assert.match(o.stillHeldOut(results, classify)[0] || '', /still held out of the site by wrongShow/);
  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  delete data.wrongShow;
  fs.writeFileSync(filepath, JSON.stringify(data));
  assert.deepEqual(o.stillHeldOut(results, classify), [], 'a later action cleared the flag');
  assert.ok(dir);
});
