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

function ingest(t, { outlet = 'thereviewshub', host = 'thereviewshub.com', rating = '', existing = {}, dryRun = false, extraFile, create = false } = {}) {
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
  fs.writeFileSync(page, `<html><head><title>${TITLE}</title></head><body><article><h1>${TITLE}</h1><p>${BODY}</p>${rating}</article></body></html>`);
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
    rows: fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse) : [],
    other: extraFile && JSON.parse(fs.readFileSync(path.join(showDir, `${outlet}--other-critic.json`))),
  };
}

test('percentage on an ingested body scores the existing canonical file without a duplicate', t => {
  const other = { showId: SHOW, outletId: 'thereviewshub', criticName: 'Other Critic', url: 'https://thereviewshub.com/another-review/', originalScore: '80%' };
  const r = ingest(t, { rating: '<p>The Reviews Hub Star Rating: 60%</p>', extraFile: other });
  assert.equal(r.data.originalScore, '60%');
  assert.equal(r.data.originalScoreNormalized, 60);
  assert.equal(r.data.scoreExtractionSource, 'reviewshub-percentage');
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.other, other);
  assert.equal(r.rows.length, 0);
});

test('HTML star rating is extracted when a body merges into the canonical file', t => {
  const r = ingest(t, { outlet: 'one-minute-critic', host: '1minutecritic.com', rating: '<img alt="4 star review">' });
  assert.equal(r.data.originalScore, '4/5');
  assert.equal(r.data.originalScoreNormalized, 80);
  assert.equal(r.data.scoreExtractionSource, 'omc-alt-text');
  assert.equal(r.files.length, 1);
});

test('a canonical body merge with no rating emits an identifiable audit row and warning', t => {
  const r = ingest(t);
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.data.originalScore, null);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].showId, SHOW);
  assert.equal(r.rows[0].stage, 'review-text-collected');
  assert.equal(r.rows[0].metadata.reason, 'merge-fulltext-no-score');
  assert.equal(r.rows[0].metadata.file, 'thereviewshub--unknown.json');
  assert.equal(r.rows[0].metadata.outletId, 'thereviewshub');
  assert.match(r.err, /Merged body has no score signal/);
});

test('an existing rating is preserved as a unit, without mixing in the new extraction', t => {
  const r = ingest(t, { existing: { originalScore: '80%', originalScoreNormalized: 80, scoreExtractionSource: 'manual-verified' }, rating: '<p>The Reviews Hub Star Rating: 60%</p>' });
  assert.equal(r.data.originalScore, '80%');
  assert.equal(r.data.originalScoreNormalized, 80);
  assert.equal(r.data.scoreExtractionSource, 'manual-verified');
  assert.equal(r.rows.length, 0);
});

test('an existing LLM score is a signal, so an unrated body merge does not emit the audit', t => {
  assert.equal(ingest(t, { existing: { llmScore: { score: 65 } } }).rows.length, 0);
});

test('an adjudicated score is also a signal', t => {
  assert.equal(ingest(t, { existing: { adjudicatedScore: 65 } }).rows.length, 0);
});

test('an empty LLM result cannot hide a merge without a score', t => {
  assert.equal(ingest(t, { existing: { llmScore: {} } }).rows.length, 1);
});

test('dry-run writes neither the body nor an audit row', t => {
  const r = ingest(t, { dryRun: true });
  assert.equal(r.data.fullText, null);
  assert.equal(r.rows.length, 0);
});

test('replacing a truncated canonical body also extracts its rating', t => {
  const r = ingest(t, { existing: { fullText: BODY.slice(0, 250), contentTier: 'truncated' }, rating: '<p>The Reviews Hub Star Rating: 60%</p>' });
  assert.ok(r.data.fullText.length > 200);
  assert.equal(r.data.originalScoreNormalized, 60);
  assert.equal(r.data.scoreExtractionSource, 'reviewshub-percentage');
});

test('new review creation is outside the merge-only no-score audit', t => {
  const r = ingest(t, { create: true });
  assert.ok(r.data.fullText.length > 200);
  assert.ok(r.rows.every(row => row.metadata?.reason !== 'merge-fulltext-no-score'));
});
