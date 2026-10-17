import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { changedThumbnailShowIds, parseAuditResult, supportsNoWrite, isReportableVerdict } = require('./new-poster-audit.js');

test('changedThumbnailShowIds finds modified and untracked thumbnails once each', () => {
  const p = ' M public/images/shows/a-2026/thumbnail.webp\n?? public/images/shows/b-2026/thumbnail.jpg\n M public/images/shows/a-2026/thumbnail.webp\n M public/images/shows/c-2026/poster.jpg\n M data/shows.json\n';
  assert.deepEqual(changedThumbnailShowIds(p), ['a-2026', 'b-2026']);
  assert.deepEqual(changedThumbnailShowIds(''), []);
});

test('parseAuditResult reads the marker line and tolerates garbage', () => {
  const out = 'x\nIMAGE_AUDIT_RESULT {"showId":"s","action":"delete","reason":"wrong_show"}\ny';
  assert.equal(parseAuditResult(out).action, 'delete');
  assert.equal(parseAuditResult('IMAGE_AUDIT_RESULT {bad'), null);
  assert.equal(parseAuditResult('nothing'), null);
});

test('supportsNoWrite detects the flag in the audit script source', () => {
  assert.equal(supportsNoWrite("const noWrite = args.includes('--no-write');"), true);
  assert.equal(supportsNoWrite('const a = 1;'), false);
});

test('only delete verdicts are reportable', () => {
  assert.equal(isReportableVerdict({ action: 'delete' }), true);
  assert.equal(isReportableVerdict({ action: 'needs_review', reason: 'api_error' }), false);
  assert.equal(isReportableVerdict({ action: 'keep' }), false);
  assert.equal(isReportableVerdict(null), false);
});
