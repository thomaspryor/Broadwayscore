/**
 * BRO-117: every producer that sets needsRescore must stamp rescoreFlaggedAt
 * at the same moment (rescore-lifecycle.js markRescoreFlagged), and every
 * path that retires the flag retires the stamp.
 *
 * Why the stamp matters:
 *   - isScoredButStillQueued() (stuck-rescore-flag.js) can only tell "queued
 *     and awaiting rescore" from "already scored, flag never retired" by
 *     comparing the score time with the enqueue time.
 *   - carryNewerScoring() (scoring-recency.js) keeps a requeue only when its
 *     stamp is newer than the other side's score (BRO-4804).
 *
 * The repo-wide scan at the bottom fails CI when a new producer sets the flag
 * without calling markRescoreFlagged() nearby. It is a regex, not a parser:
 * a variable RHS (`d.needsRescore = flag`) or bracket notation slips past it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const { markRescoreFlagged, markRescoreComplete } = require('./rescore-lifecycle.js');
const { markRescoreNeeded } = require('./rescore-flagging.js');
const { isIntentionalClear, PROTECTED_FIELDS, CLEAR_BREADCRUMBS } = require('./review-write-guard.js');
const { isScoredButStillQueued } = require('./stuck-rescore-flag.js');
const { carryNewerScoring } = require('./scoring-recency.js');

// Same restore decision the push-review-texts restore uses (see
// tests/unit/intentional-clear-breadcrumb.test.mjs): restore only when the
// field is empty locally, present in committed HEAD, and not a deliberate clear.
const isEmptyVal = (v) => v === undefined || v === null
  || (typeof v === 'string' && v.length === 0) || (Array.isArray(v) && v.length === 0);
function wouldRestore(field, local, committed) {
  if (isEmptyVal(local[field]) && isIntentionalClear(field, local, committed)) return false;
  return !isEmptyVal(committed[field]) && isEmptyVal(local[field]);
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ── write side ────────────────────────────────────────────────────────────

test('markRescoreFlagged stamps the given time and returns the same object', () => {
  const f = { needsRescore: true };
  assert.equal(markRescoreFlagged(f, '2026-10-01T00:00:00.000Z'), f);
  assert.equal(f.rescoreFlaggedAt, '2026-10-01T00:00:00.000Z');
});

test('markRescoreFlagged defaults to a valid now() timestamp', () => {
  const before = Date.now();
  const f = markRescoreFlagged({ needsRescore: 'ap-content-detected' });
  const at = Date.parse(f.rescoreFlaggedAt);
  assert.ok(at >= before && at <= Date.now() + 1000);
});

test('markRescoreFlagged restamps a re-flag (a requeue is a new enqueue)', () => {
  // Keeping an older stamp would let carryNewerScoring treat this fresh
  // requeue as a stale snapshot whenever HEAD scored the file in between.
  const f = { needsRescore: true, rescoreFlaggedAt: '2026-08-01T00:00:00.000Z' };
  markRescoreFlagged(f, '2026-10-01T00:00:00.000Z');
  assert.equal(f.rescoreFlaggedAt, '2026-10-01T00:00:00.000Z');
});

test('markRescoreFlagged leaves needsRescore alone and no-ops on non-objects', () => {
  const f = { needsRescore: 'fullTextWrongAuthor-applied' };
  markRescoreFlagged(f);
  assert.equal(f.needsRescore, 'fullTextWrongAuthor-applied');
  assert.equal(markRescoreFlagged(null), null);
  assert.equal(markRescoreFlagged(undefined), undefined);
});

test('markRescoreNeeded (rescore-flagging.js) stamps through markRescoreFlagged', () => {
  const f = markRescoreNeeded({}, 'stale input', '2026-10-02T00:00:00.000Z');
  assert.equal(f.needsRescore, true);
  assert.equal(f.rescoreFlaggedAt, '2026-10-02T00:00:00.000Z');
});

test('markRescoreComplete retires rescoreFlaggedAt with the flag', () => {
  const f = { needsRescore: true, rescoreFlaggedAt: '2026-08-01T00:00:00.000Z' };
  markRescoreComplete(f, '2026-10-01T00:00:00.000Z');
  assert.equal(f.needsRescore, undefined);
  assert.equal(f.rescoreFlaggedAt, undefined);
  assert.equal(f.rescoreCompletedAt, '2026-10-01T00:00:00.000Z');
});

// ── push-restore protection ───────────────────────────────────────────────

test('rescoreFlaggedAt is protected and shares needsRescore clear breadcrumbs', () => {
  assert.ok(PROTECTED_FIELDS.includes('rescoreFlaggedAt'));
  assert.equal(typeof CLEAR_BREADCRUMBS.rescoreFlaggedAt, 'function');
});

test('a dropped stamp is restored from committed HEAD when nothing retired it', () => {
  const committed = { needsRescore: true, rescoreFlaggedAt: daysAgo(1) };
  const local = { needsRescore: true };
  assert.equal(wouldRestore('rescoreFlaggedAt', local, committed), true);
});

test('a fresh markRescoreComplete retirement is not resurrected by the restore', () => {
  const committed = { needsRescore: true, rescoreFlaggedAt: daysAgo(5) };
  const local = markRescoreComplete({ needsRescore: true, rescoreFlaggedAt: daysAgo(5) });
  assert.equal(wouldRestore('needsRescore', local, committed), false);
  assert.equal(wouldRestore('rescoreFlaggedAt', local, committed), false);
});

test('a fresh audit --fix clear (stuckRescoreCleared) is not resurrected either', () => {
  const committed = { needsRescore: true, rescoreFlaggedAt: daysAgo(5) };
  const local = { stuckRescoreCleared: true, stuckRescoreClearedAt: new Date().toISOString() };
  assert.equal(wouldRestore('rescoreFlaggedAt', local, committed), false);
});

test('an old completion stamp does not suppress restoring a later stamp forever', () => {
  const committed = { needsRescore: true, rescoreFlaggedAt: daysAgo(1) };
  const local = { rescoreCompletedAt: daysAgo(10) };
  assert.equal(wouldRestore('rescoreFlaggedAt', local, committed), true);
});

test('audit-stuck-rescore-flags.js --fix deletes the stamp with the flag', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/audit-stuck-rescore-flags.js'), 'utf8');
  assert.match(src, /delete d\.needsRescore;[\s\S]{0,80}delete d\.rescoreFlaggedAt;/);
});

// ── carry interplay (scoring-recency.js) ──────────────────────────────────

test('a producer requeue stamped after HEAD\'s score survives carryNewerScoring', () => {
  const head = { llmScore: { score: 70 }, llmMetadata: { scoredAt: daysAgo(1) }, rescoreCompletedAt: daysAgo(1) };
  const local = { llmScore: { score: 60 }, llmMetadata: { scoredAt: daysAgo(3) }, needsRescore: true };
  markRescoreFlagged(local);
  const r = carryNewerScoring(local, head);
  assert.equal(r.changed, false);
  assert.equal(local.needsRescore, true);
});

test('the carry requeue on a body change is itself stamped', () => {
  const head = { fullText: 'old body', llmScore: { score: 70 }, llmMetadata: { scoredAt: daysAgo(1) } };
  const local = { fullText: 'new body', llmScore: { score: 60 }, llmMetadata: { scoredAt: daysAgo(3) } };
  const r = carryNewerScoring(local, head);
  assert.equal(r.changed, true);
  assert.equal(local.needsRescore, true);
  assert.ok(Date.parse(local.rescoreFlaggedAt) > Date.parse(head.llmMetadata.scoredAt));
});

// ── detector (stuck-rescore-flag.js) ──────────────────────────────────────

test('isScoredButStillQueued: any producer, scored after the stamp, flag still set => stuck', () => {
  assert.equal(isScoredButStillQueued({
    needsRescore: true, scoreSource: 'llm-ensemble-v6',
    rescoreFlaggedAt: '2026-10-01T00:00:00.000Z',
    llmMetadata: { scoredAt: '2026-10-03T00:00:00.000Z' },
  }), true);
});

test('isScoredButStillQueued: score older than the stamp is a legitimate requeue', () => {
  assert.equal(isScoredButStillQueued({
    needsRescore: true, scoreSource: 'llm-ensemble-v6',
    rescoreFlaggedAt: '2026-10-03T00:00:00.000Z',
    llmMetadata: { scoredAt: '2026-10-01T00:00:00.000Z' },
  }), false);
});

test('isScoredButStillQueued: no stamp on a non-fallback file stays presumed legitimate', () => {
  assert.equal(isScoredButStillQueued({
    needsRescore: true, scoreSource: 'llm-ensemble-v6',
    llmMetadata: { scoredAt: '2026-10-01T00:00:00.000Z' },
  }), false);
});

test('isScoredButStillQueued: Haiku-fallback fingerprint keeps its original behaviour', () => {
  const base = { needsRescore: true, scoreSource: 'manual-cleared-haiku-fallback', llmMetadata: { scoredAt: '2026-10-02T00:00:00.000Z' } };
  assert.equal(isScoredButStillQueued(base), true);
  assert.equal(isScoredButStillQueued({ ...base, rescoreFlaggedAt: '2026-10-03T00:00:00.000Z' }), false);
  assert.equal(isScoredButStillQueued({ ...base, rescoreCompletedAt: '2026-10-02T00:00:00.000Z' }), false);
});

test('isScoredButStillQueued: compares instants, not strings (offset vs Z)', () => {
  // 2026-10-02T01:00:00+02:00 is 2026-10-01T23:00Z, before the flag at 2026-10-02T00:00Z.
  assert.equal(isScoredButStillQueued({
    needsRescore: true, scoreSource: 'llm-ensemble-v6',
    rescoreFlaggedAt: '2026-10-02T00:00:00.000Z',
    llmMetadata: { scoredAt: '2026-10-02T01:00:00+02:00' },
  }), false);
});

// ── repo-wide producer scan ───────────────────────────────────────────────

// Files that define or read the contract rather than enqueue.
const SKIP = new Set([
  'scripts/lib/rescore-lifecycle.js',
  'scripts/lib/stuck-rescore-flag.js',
]);

function listScriptFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name)) continue;
      if (/\.test\.(c?js|mjs|ts)$/.test(e.name)) continue;
      out.push(full);
    }
  })(path.join(REPO, 'scripts'));
  return out;
}

// Code shapes only: a member assignment (`d.needsRescore = true` / `= 'reason'`)
// and an object-literal key alone on its line (`needsRescore: true,`). Prose in
// comments/help text ("sets needsRescore=true") has no leading `.` or is not
// alone on its line, so it does not match.
const MEMBER_ASSIGN_RE = /\.needsRescore\s*=\s*(?:true\b|'[^']*'|"[^"]*"|`[^`]*`)(?!\s*[=?])/g;
const OBJECT_KEY_RE = /^[ \t]*needsRescore\s*:\s*(?:true\b|'[^']*'|"[^"]*")\s*,?\s*$/gm;

test('every needsRescore producer under scripts/ calls markRescoreFlagged nearby', () => {
  const missing = [];
  let sites = 0;
  for (const file of listScriptFiles()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (SKIP.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (const re of [MEMBER_ASSIGN_RE, OBJECT_KEY_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length; // 1-based
        // Object literals stamp once after the literal closes, so look further ahead for them.
        const ahead = re === OBJECT_KEY_RE ? 12 : 6;
        const win = lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + ahead)).join('\n');
        sites++;
        if (!/markRescoreFlagged\(/.test(win)) missing.push(`${rel}:${line}`);
      }
    }
  }
  // Boolean enqueues now share markRescoreNeeded (BRO-5587); legacy string
  // producers still stamp directly. The chokepoint test guards consolidation.
  assert.ok(sites >= 1, `expected to find the canonical producer, saw ${sites} sites`);
  assert.deepEqual(missing, [],
    `set needsRescore without markRescoreFlagged() nearby: ${missing.join(', ')}. ` +
    'Call markRescoreFlagged(data) from scripts/lib/rescore-lifecycle.js right after setting the flag.');
});
