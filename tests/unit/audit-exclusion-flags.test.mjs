/** BRO-57: exercise the real audit's report, clear, lock and logging paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { applyClear } = require('../../scripts/audit-exclusion-flags.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/audit-exclusion-flags.js');

function review(showId, nonReviewType = 'preview') {
  return {
    showId,
    showTitle: 'An Autumn Journey',
    venue: 'Orchard Theatre, Example City',
    isNonReview: true,
    nonReviewType,
    nonReviewClassifiedBy: 'gemini',
    assignedScore: 88,
    fullText: 'The author recalls a childhood spent exploring family history and the music of earlier generations. '.repeat(30)
      + 'An Autumn Journey at Orchard Theatre is directed by Alex Example. The performance is thrilling. '
      + 'The cast brings an extraordinary warmth to every scene, revealing the complicated relationships within the family. '.repeat(15)
      + 'You should see this. You will be glad you did.',
  };
}

function corpus(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-57-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'review-texts');
  const log = path.join(dir, 'audit.json');
  const first = review('autumn-regional-2025');
  const second = review('autumn-regional-2026', 'interview');
  const records = {
    [`${first.showId}/essay.json`]: first,
    [`${second.showId}/interview.json`]: second,
    [`${first.showId}/press-release.json`]: { ...first, nonReviewType: 'press_release' },
    [`${first.showId}/preview.json`]: { ...first, fullText: first.fullText + ' Previews begin next week.' },
    [`${first.showId}/wrong-article.json`]: { ...first, contentVerification: { wrongArticle: true } },
    [`${first.showId}/locked.json`]: { ...first, nonReviewManualClear: true },
    [`${first.showId}/cleared.json`]: { ...first, isNonReview: false },
  };
  for (const [rel, data] of Object.entries(records)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  const snapshot = () => Object.fromEntries(Object.keys(records).map(rel => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, REVIEW_TEXTS_DIR: root, EXCLUSION_FLAGS_AUDIT_LOG: log },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  return { records, root, log, snapshot, run };
}

test('report-only finds both essay-intro classes and logs them without changing records', t => {
  const c = corpus(t);
  const before = c.snapshot();
  const report = JSON.parse(c.run('--json'));
  assert.equal(report.scanned, 7);
  assert.equal(report.count, 2);
  assert.equal(report.applied, false);
  assert.deepEqual(report.hits.map(h => h.nonReviewType).sort(), ['interview', 'preview']);
  assert.ok(report.hits.every(h => h.venueChecked && h.score === 88));
  assert.deepEqual(c.snapshot(), before);
  const log = JSON.parse(fs.readFileSync(c.log, 'utf8'));
  assert.equal(log._meta.applied, false);
  assert.deepEqual(log.hits, report.hits);
});

test('--apply clears only matches, stamps the lock and verification, and logs each change', t => {
  const c = corpus(t);
  const before = c.snapshot();
  const output = c.run('--apply');
  assert.match(output, /7 review file\(s\) scanned, 2 match\(es\) \(APPLIED\)/);
  const log = JSON.parse(fs.readFileSync(c.log, 'utf8'));
  assert.equal(log._meta.applied, true);
  assert.equal(log._meta.count, 2);
  assert.equal(log.hits.length, 2);
  const changed = new Set(log.hits.map(h => `${h.showId}/${h.file}`));
  assert.deepEqual([...changed].sort(), ['autumn-regional-2025/essay.json', 'autumn-regional-2026/interview.json']);
  for (const [rel, raw] of Object.entries(c.snapshot())) {
    if (!changed.has(rel)) {
      assert.equal(raw, before[rel], `${rel} must remain unchanged`);
      continue;
    }
    assert.ok(output.includes(rel), `${rel} must appear in the change log`);
    const data = JSON.parse(raw);
    assert.equal(data.isNonReview, false);
    assert.equal(data.nonReviewManualClear, true);
    assert.equal(data.assignedScore, c.records[rel].assignedScore);
    assert.equal(data.fullText, c.records[rel].fullText);
    assert.equal(data.contentVerification.articleType, 'review');
    assert.equal(data.contentVerification.wrongArticle, false);
    assert.equal(data.contentVerification.verifiedBy, 'audit-exclusion-flags:essay-intro-fp');
    assert.ok(Number.isFinite(Date.parse(data.contentVerification.verifiedAt)));
    assert.match(data.contentVerification.reasoning, /Auto-cleared by audit-exclusion-flags\.js/);
  }
  const after = c.snapshot();
  const rerun = JSON.parse(c.run('--apply', '--json'));
  assert.equal(rerun.scanned, 7);
  assert.equal(rerun.count, 0, 'locked clears must not be processed again');
  assert.deepEqual(c.snapshot(), after, 'repeat apply must not restamp records');
});

test('--show scopes clearing and logging to the selected production', t => {
  const c = corpus(t);
  const before = c.snapshot();
  const report = JSON.parse(c.run('--apply', '--show=autumn-regional-2026', '--json'));
  assert.equal(report.scanned, 1);
  assert.equal(report.count, 1);
  assert.equal(report.hits[0].showId, 'autumn-regional-2026');
  const after = c.snapshot();
  for (const rel of Object.keys(before).filter(rel => rel.startsWith('autumn-regional-2025/'))) {
    assert.equal(after[rel], before[rel]);
  }
  assert.equal(JSON.parse(after['autumn-regional-2026/interview.json']).nonReviewManualClear, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.log, 'utf8')).hits, report.hits);
});

test('the real clear preserves scores, attribution and independent exclusion evidence', () => {
  const data = {
    ...review('autumn-regional-2025'),
    wrongShow: true,
    wrongProduction: true,
    wrongAttribution: true,
    contentVerification: { wrongProduction: true, isFilmTv: true, truncated: true, issues: ['other evidence'], custom: 'preserved' },
  };
  const before = structuredClone(data);
  applyClear(data, { nonReviewType: 'preview', venueChecked: true });
  assert.equal(data.isNonReview, false);
  assert.equal(data.nonReviewManualClear, true);
  for (const field of Object.keys(before).filter(field => !['isNonReview', 'contentVerification'].includes(field))) {
    assert.deepEqual(data[field], before[field], field);
  }
  for (const field of Object.keys(before.contentVerification)) {
    assert.deepEqual(data.contentVerification[field], before.contentVerification[field], field);
  }
});
