// BRO-5326: Fish (WP Theater) opened with Big Fish art as its poster and the
// readiness check passed a show with 12 review files as a "clean slate".
// require()s the real decisions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const g = require('./readiness-guards.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('audit line round-trips through the real formatter and parser', () => {
  const out = `[1/1] Fish (fish-off-broadway-2026)... DELETE - menu board\n${g.formatImageAuditLine({ showId: 'fish-off-broadway-2026', action: 'delete', reason: 'llm says no', description: 'menu board' })}\nAudit summary...\n`;
  assert.deepEqual(g.parseImageAuditLine(out), { showId: 'fish-off-broadway-2026', action: 'delete', reason: 'llm says no', description: 'menu board' });
});

test('parser returns null when the audit printed nothing usable', () => {
  assert.equal(g.parseImageAuditLine(''), null);
  assert.equal(g.parseImageAuditLine(undefined), null);
  assert.equal(g.parseImageAuditLine('IMAGE_AUDIT_RESULT {not json'), null);
});

test('only an explicit keep passes the poster check', () => {
  assert.equal(g.posterReadiness({ action: 'keep', description: 'WP Theater poster' }).status, 'pass');
  assert.equal(g.posterReadiness({ action: 'delete', description: 'Big Fish musical art' }).status, 'warn');
  assert.equal(g.posterReadiness({ action: 'review', reason: 'low confidence' }).status, 'warn');
});

test('an audit that could not run is a skip, never a pass or a failure', () => {
  assert.equal(g.posterReadiness(null).status, 'skip');
  assert.equal(g.posterReadiness({ action: 'keep' }, { hasKey: false }).status, 'skip');
});

test('a child failure is named in the skip, so an outage is not mistaken for "not checked"', () => {
  assert.equal(g.describeSpawnFailure({ status: 0 }), null);
  assert.equal(g.describeSpawnFailure({ error: { code: 'ETIMEDOUT' } }), 'timed out');
  assert.equal(g.describeSpawnFailure({ signal: 'SIGTERM' }), 'killed by SIGTERM');
  assert.equal(g.describeSpawnFailure({ status: 1, stderr: 'a\nERROR: GEMINI_API_KEY not found\n' }), 'exit 1: ERROR: GEMINI_API_KEY not found');
  const r = g.posterReadiness(null, { failure: 'timed out' });
  assert.equal(r.status, 'skip');
  assert.match(r.detail, /timed out.*NOT verified/);
});

test('a Gemini outage (reason api_error) is a skip, not a bad-poster warning', () => {
  const r = g.posterReadiness({ action: 'review', reason: 'api_error', description: 'API error after 3 retries: key not valid' });
  assert.equal(r.status, 'skip');
  assert.match(r.detail, /NOT verified/);
});

test('a wrong poster verdict names the fix command', () => {
  assert.match(g.posterReadiness({ action: 'delete', description: 'x' }).detail, /fetch-show-images-auto\.js/);
});

test('review files present passes whether or not the show has opened', () => {
  const base = { openingDate: '2026-10-11', today: '2026-10-14', dirExists: true, wrongProductionCount: 0 };
  assert.equal(g.preExistingReviewsReadiness({ ...base, fileCount: 12 }).status, 'pass');
  assert.equal(g.preExistingReviewsReadiness({ ...base, openingDate: '2026-11-01', fileCount: 3 }).status, 'pass');
});

test('no review files before opening is a clean slate (pass)', () => {
  const r = g.preExistingReviewsReadiness({ openingDate: '2026-11-01', today: '2026-10-14', dirExists: false, fileCount: 0, wrongProductionCount: 0 });
  assert.equal(r.status, 'pass');
});

test('no review files AFTER opening is a warning, the Fish false pass', () => {
  const none = g.preExistingReviewsReadiness({ openingDate: '2026-10-11', today: '2026-10-14', dirExists: false, fileCount: 0, wrongProductionCount: 0 });
  assert.equal(none.status, 'warn');
  assert.match(none.detail, /no review-texts directory was found/);
  const empty = g.preExistingReviewsReadiness({ openingDate: '2026-10-11', today: '2026-10-12', dirExists: true, fileCount: 0, wrongProductionCount: 0 });
  assert.equal(empty.status, 'warn');
  assert.match(empty.detail, /directory is empty/);
});

test('opening day itself is still a clean slate: reviews drop that night', () => {
  const r = g.preExistingReviewsReadiness({ openingDate: '2026-10-11', today: '2026-10-11', dirExists: false, fileCount: 0, wrongProductionCount: 0 });
  assert.equal(r.status, 'pass');
});

test('a show with no image file warns with a message that says so', () => {
  const r = g.posterReadiness({ action: 'skip', reason: 'no_thumbnail' });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no poster\/thumbnail image file/);
  assert.doesNotMatch(r.detail, /unsure/);
});

test('wrong-production files warn even when other files exist', () => {
  assert.equal(g.preExistingReviewsReadiness({ openingDate: '2026-10-11', today: '2026-10-14', dirExists: true, fileCount: 12, wrongProductionCount: 6 }).status, 'warn');
});

test('the readiness script and the audit script are wired to these helpers', () => {
  const ready = fs.readFileSync(path.join(root, 'scripts/check-opening-night-readiness.js'), 'utf8');
  assert.match(ready, /readiness-guards/);
  assert.match(ready, /audit-images-llm\.js/);
  const audit = fs.readFileSync(path.join(root, 'scripts/audit-images-llm.js'), 'utf8');
  assert.match(audit, /formatImageAuditLine/);
  assert.match(audit, /--no-write/);
});
