// BRO-4042: a body ingested onto an existing canonical review-texts file must
// also record the page's explicit rating, and a merge that leaves a body with
// no score signal must be visible in the audit log rather than silent.
// Runs the real ingest-review-from-url.js offline (stub fetchPage) against a
// temp corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHOW = 'catarina-and-the-beauty-of-killing-fascists-west-end-2026';
const TITLE = 'Catarina and the Beauty of Killing Fascists';
const BODY = `${TITLE} brings a family ritual into conflict with the politics of the present. The cast gives the debate clarity and the staging keeps the audience engaged throughout the evening. `.repeat(20);

function ingest(t, { outlet = 'thereviewshub', host = 'thereviewshub.com', rating = '', existing = {}, dryRun = false, extraFile, create = false, pageTitle = TITLE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const showDir = path.join(dir, SHOW);
  fs.mkdirSync(showDir);
  const url = `https://${host}/catarina-review/`;
  const filename = `${outlet}--unknown.json`;
  if (!create) fs.writeFileSync(path.join(showDir, filename), JSON.stringify({
    showId: SHOW, outletId: outlet, criticName: 'Unknown', url,
    contentTier: 'stub', fullText: null, originalScore: null, ...existing,
  }));
  if (extraFile) fs.writeFileSync(path.join(showDir, `${outlet}--other-critic.json`), JSON.stringify(extraFile));
  const page = path.join(dir, 'page.html');
  const body = pageTitle === TITLE ? BODY : BODY.split(TITLE).join(pageTitle);
  fs.writeFileSync(page, `<html><head><title>${pageTitle}</title></head><body><article><h1>${pageTitle}</h1><p>${body}</p>${rating}</article></body></html>`);
  const audit = path.join(dir, 'audit.jsonl');
  const run = spawnSync(process.execPath, [
    '-r', path.join(ROOT, 'tests/fixtures/ingest-merge-rescores/stub-fetch.cjs'),
    path.join(ROOT, 'scripts/ingest-review-from-url.js'),
    `--show=${SHOW}`, `--url=${url}`, `--outlet=${outlet}`, `--data-dir=${dir}`,
    ...(dryRun ? ['--dry-run'] : []),
  ], { encoding: 'utf8', timeout: 60000, env: { ...process.env, INGEST_MERGE_PAGE: page, STAGE_LATENCY_LOG: audit } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return {
    data: JSON.parse(fs.readFileSync(path.join(showDir, filename))),
    files: fs.readdirSync(showDir), out: run.stdout, err: run.stderr,
    rows: fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    other: extraFile && JSON.parse(fs.readFileSync(path.join(showDir, `${outlet}--other-critic.json`))),
  };
}
const noScoreRows = (r) => r.rows.filter((row) => row.metadata?.reason === 'merge-fulltext-no-score');

test('percentage on an ingested body scores the existing canonical file without a duplicate', t => {
  const other = { showId: SHOW, outletId: 'thereviewshub', criticName: 'Other Critic', url: 'https://thereviewshub.com/another-review/', originalScore: '80%' };
  const r = ingest(t, { rating: '<p>The Reviews Hub Star Rating: 60%</p>', extraFile: other });
  assert.equal(r.data.originalScore, '60%');
  assert.equal(r.data.originalScoreNormalized, 60);
  assert.equal(r.data.originalScoreSource, 'reviewshub-percentage');
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.other, other);
  assert.equal(noScoreRows(r).length, 0);
});

test('HTML star rating is extracted when a body merges into the canonical file', t => {
  const r = ingest(t, { outlet: 'one-minute-critic', host: '1minutecritic.com', rating: '<img alt="4 star review">' });
  assert.equal(r.data.originalScore, '4/5');
  assert.equal(r.data.originalScoreNormalized, 80);
  assert.ok(r.data.originalScoreSource);
  assert.equal(r.files.length, 1);
});

test('an unrated body merge the scorer will pick up is normal, not audited', t => {
  const r = ingest(t);
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.data.originalScore, null);
  assert.equal(noScoreRows(r).length, 0);
  assert.doesNotMatch(r.err, /Merged body has no score signal/);
});

test('an unrated body merge the scorer will skip emits an identifiable audit row and warning', t => {
  // llmScore {} reads as "already scored" to the scorer's selection filter,
  // yet carries no score: the exact stuck state BRO-4042 is about.
  const r = ingest(t, { existing: { llmScore: {} } });
  const rows = noScoreRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].showId, SHOW);
  assert.equal(rows[0].stage, 'review-text-collected');
  assert.equal(rows[0].metadata.file, 'thereviewshub--unknown.json');
  assert.equal(rows[0].metadata.outletId, 'thereviewshub');
  assert.ok(rows[0].metadata.skipReason);
  assert.equal(rows[0].reviewKey, 'thereviewshub:unknown:https://thereviewshub.com/catarina-review/');
  assert.match(r.err, /Merged body has no score signal and the scorer will skip it/);
});

test('an existing rating is preserved as a unit, without mixing in the new extraction', t => {
  const r = ingest(t, { existing: { originalScore: '80%', originalScoreNormalized: 80, originalScoreSource: 'manual-verified' }, rating: '<p>The Reviews Hub Star Rating: 60%</p>' });
  assert.equal(r.data.originalScore, '80%');
  assert.equal(r.data.originalScoreNormalized, 80);
  assert.equal(r.data.originalScoreSource, 'manual-verified');
  assert.equal(noScoreRows(r).length, 0);
});

test('an existing LLM score is a signal, so an unrated body merge does not emit the audit', t => {
  assert.equal(noScoreRows(ingest(t, { existing: { llmScore: { score: 65 } } })).length, 0);
});

test('dry-run writes neither the body nor an audit row', t => {
  const r = ingest(t, { dryRun: true, existing: { llmScore: {} } });
  assert.equal(r.data.fullText, null);
  assert.equal(noScoreRows(r).length, 0);
});

test('replacing a truncated canonical body also extracts its rating', t => {
  const r = ingest(t, { existing: { fullText: BODY.slice(0, 250), contentTier: 'truncated' }, rating: '<p>The Reviews Hub Star Rating: 60%</p>' });
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.data.originalScoreNormalized, 60);
  assert.equal(r.data.originalScoreSource, 'reviewshub-percentage');
});

test('new review creation is outside the merge-only no-score audit', t => {
  const r = ingest(t, { create: true });  // a new file is never a merge
  assert.ok(r.data.fullText.length > 200);
  assert.equal(noScoreRows(r).length, 0);
});

test('a rating the title check cannot trust is not recorded', t => {
  const r = ingest(t, { pageTitle: 'Some Other Play Entirely', rating: '<p>The Reviews Hub Star Rating: 60%</p>' });
  assert.equal(r.data.originalScore, null);
});
