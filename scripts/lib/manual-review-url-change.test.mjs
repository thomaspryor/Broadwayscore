import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer');
const { buildManualReviewFields } = require('./manual-review-fields');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const showId = 'hamilton-2015';
const criticName = 'BRO Regression Critic';
const url = 'https://www.vulture.com/article/hamilton-review.html';
const fullText = 'Hamilton at the Richard Rodgers Theatre is a stirring musical, with expressive performances and inventive staging. '.repeat(35);

function fixture(t, { oldBody = null, sameUrl = false, existing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(root, '.bro-3151-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir);
  const filepath = path.join(showDir, 'vulture--bro-regression-critic.json');
  if (existing) fs.writeFileSync(filepath, JSON.stringify({
    showId, outletId: 'vulture', outlet: 'Vulture', criticName,
    url: sameUrl ? url : 'https://www.vulture.com/article/hamilton-old-review.html',
    source: 'manual-entry', fullText: oldBody, contentTier: 'stub',
    excludeFromScoring: true, rejectedAt: '2026-09-10T15:39:41Z', needsRefetch: true,
  }));
  return { dir, filepath };
}

for (const [name, oldBody] of [['empty old slot', null], ['identical incoming body', fullText]]) {
  test(`URL change preserves incoming body and resets stale state: ${name}`, t => {
    const { dir, filepath } = fixture(t, { oldBody });
    const result = createOrMergeReviewFile(showId, {
      outletId: 'vulture', outlet: 'Vulture', criticName, url, source: 'manual-entry',
      fields: buildManualReviewFields({ fullText }),
    }, { reviewTextsDir: dir });
    assert.equal(result.action, 'updated');
    const saved = JSON.parse(fs.readFileSync(filepath));
    assert.equal(saved.url, url);
    assert.equal(saved.fullText, fullText);
    assert.notEqual(saved.excludeFromScoring, true);
    assert.equal(saved.rejectedAt, undefined);
    assert.notEqual(saved.needsRefetch, true);
  });
}

test('unchanged URL keeps exclusion state', t => {
  const { dir, filepath } = fixture(t, { sameUrl: true });
  createOrMergeReviewFile(showId, {
    outletId: 'vulture', outlet: 'Vulture', criticName, url, source: 'manual-entry',
    fields: buildManualReviewFields({ fullText }),
  }, { reviewTextsDir: dir });
  const saved = JSON.parse(fs.readFileSync(filepath));
  assert.equal(saved.excludeFromScoring, true);
});

test('score-only URL correction requests refetch', t => {
  const { dir, filepath } = fixture(t);
  const result = createOrMergeReviewFile(showId, {
    outletId: 'vulture', outlet: 'Vulture', criticName, url, source: 'manual-entry',
    fields: buildManualReviewFields({ humanScore: 80 }),
  }, { reviewTextsDir: dir });
  assert.equal(result.action, 'updated');
  const saved = JSON.parse(fs.readFileSync(filepath));
  assert.notEqual(saved.excludeFromScoring, true);
  assert.equal(saved.rejectedAt, undefined);
  assert.equal(saved.needsRefetch, true);
});

for (const previouslyFlagged of [false, true]) {
  test(`URL reset preserves a fresh wrong-show verdict (previously flagged: ${previouslyFlagged})`, t => {
    const { dir, filepath } = fixture(t);
    if (previouslyFlagged) {
      const old = JSON.parse(fs.readFileSync(filepath));
      old.wrongShow = true;
      fs.writeFileSync(filepath, JSON.stringify(old));
    }
    const wrongBody = 'Wicked is an exceptional musical about two unlikely friends. Every song unfolds beautifully with colorful staging and wonderful dancing. '.repeat(35);
    const result = createOrMergeReviewFile(showId, {
      outletId: 'vulture', outlet: 'Vulture', criticName, url, source: 'manual-entry',
      fields: buildManualReviewFields({ fullText: wrongBody }),
    }, { reviewTextsDir: dir });
    assert.equal(result.action, 'updated');
    const saved = JSON.parse(fs.readFileSync(filepath));
    assert.equal(saved.wrongShow, true);
    assert.match(saved.wrongShowReason, /never names "Hamilton"/);
    assert.equal(saved.fullText, wrongBody);
  });
}

function runCli(dir, corrupt = false, extraArgs = []) {
  // Redirect the actual writer to an isolated fixture. Corruption simulates a
  // write that reports success but loses its body; the CLI must inspect disk.
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const writer = require(${JSON.stringify(path.join(root, 'scripts/lib/review-file-writer.js'))});
    const original = writer.createOrMergeReviewFile;
    writer.createOrMergeReviewFile = (showId, input, options) => {
      const result = original(showId, input, { ...options, reviewTextsDir: ${JSON.stringify(dir)} });
      if (${corrupt} && result.filepath && !options.dryRun) {
        const saved = JSON.parse(fs.readFileSync(result.filepath));
        saved.fullText = '';
        fs.writeFileSync(result.filepath, JSON.stringify(saved));
      }
      return result;
    };
  `);
  return spawnSync(process.execPath, ['--require', preload,
    path.join(root, 'scripts/ingest-manual-review.js'), `--show=${showId}`,
    '--outlet=vulture', `--critic=${criticName}`, `--url=${url}`, `--text=${fullText}`,
    '--no-auto-extract', '--no-rebuild', ...extraArgs], { cwd: root, encoding: 'utf8' });
}

test('direct URL CLI preserves body and clears stale state', t => {
  const { dir, filepath } = fixture(t, { oldBody: fullText });
  const result = runCli(dir);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(filepath));
  assert.equal(saved.fullText, fullText);
  assert.notEqual(saved.excludeFromScoring, true);
  assert.equal(saved.rejectedAt, undefined);
  assert.notEqual(saved.needsRefetch, true);
});

for (const existing of [true, false]) {
  test(`CLI fails loudly when saved body disappears (${existing ? 'update' : 'new'})`, t => {
    const { dir } = fixture(t, { existing });
    const result = runCli(dir, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incoming body.*fullText.*empty/i);
    assert.doesNotMatch(result.stdout, /Done\./);
  });
}

test('dry run skips post-write assertion and preserves fixture', t => {
  const { dir, filepath } = fixture(t);
  const before = fs.readFileSync(filepath, 'utf8');
  const result = runCli(dir, false, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(filepath, 'utf8'), before);
});
