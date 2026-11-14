import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildShowExclusionsPayload,
  writeShowExclusionsFile,
  showExclusionsPath,
} = require('./rebuild-exclusion-audit.js');

test('buildShowExclusionsPayload — pure shape, no I/O', () => {
  const payload = buildShowExclusionsPayload('hamilton-2015', [
    { file: 'nytimes--unknown.json', reason: 'skippedWrongShow' },
    { file: 'guardian--unknown.json', reason: 'skippedDuplicateText', evidence: { duplicateOf: 'x.json' } },
  ]);
  assert.equal(payload.showId, 'hamilton-2015');
  assert.equal(payload.count, 2);
  assert.equal(payload.exclusions.length, 2);
  assert.equal(payload.exclusions[0].file, 'nytimes--unknown.json');
  assert.equal(payload.exclusions[0].reason, 'skippedWrongShow');
  assert.deepEqual(payload.exclusions[0].evidence, {});
  assert.deepEqual(payload.exclusions[1].evidence, { duplicateOf: 'x.json' });
  assert.ok(payload.generatedAt);
});

test('writeShowExclusionsFile — no-ops for zero exclusions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-exclusion-audit-'));
  try {
    assert.equal(writeShowExclusionsFile('some-show', [], dir), null);
    assert.equal(fs.existsSync(showExclusionsPath('some-show', dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeShowExclusionsFile — writes data/audit/rebuild-exclusions-{showId}.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-exclusion-audit-'));
  try {
    const records = [{ file: 'wsj--unknown.json', reason: 'skippedNoScore', evidence: { firedSignals: ['blockedSingleModel'] } }];
    const outPath = writeShowExclusionsFile('fear-of-13-2026', records, dir);
    assert.equal(outPath, showExclusionsPath('fear-of-13-2026', dir));
    assert.ok(fs.existsSync(outPath));
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(written.showId, 'fear-of-13-2026');
    assert.equal(written.count, 1);
    assert.equal(written.exclusions[0].file, 'wsj--unknown.json');
    assert.equal(written.exclusions[0].reason, 'skippedNoScore');
    assert.deepEqual(written.exclusions[0].evidence, { firedSignals: ['blockedSingleModel'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
