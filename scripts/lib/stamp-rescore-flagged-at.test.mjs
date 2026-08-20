/**
 * Guards the BRO-117 fix (Notion 3a9637c5-416f-8155): every producer that
 * flags a review `needsRescore` must also stamp `rescoreFlaggedAt` at the
 * same moment. Before this, 16+ producers set the flag with no enqueue
 * timestamp, so isScoredButStillQueued() (scripts/lib/stuck-rescore-flag.js)
 * could only recognize ONE producer's stuck-flag fingerprint
 * (scoreSource === 'manual-cleared-haiku-fallback') and reported every other
 * scored-but-still-queued file as report-only, forever, with no way to tell
 * "legitimately awaiting rescore" from "already scored, flag never retired".
 *
 * Tests 1-5 cover the pure write-side helpers in rescore-lifecycle.js.
 * Test 6 asserts the stamp survives a rebase restore (review-write-guard.js
 * PROTECTED_FIELDS) — an unprotected stamp would be silently dropped the
 * moment a producer's own commit races push-review-texts, defeating the
 * fix on every affected file.
 * Test 7 is the one that actually prevents recurrence for producers not yet
 * written: it scans every scripts/**\/*.js file for a `needsRescore =`
 * assignment and asserts markRescoreFlagged() is called near it. A new
 * producer added later without the call fails here, the same way
 * tests/unit/rescore-lifecycle.test.mjs's index.ts scan catches a new
 * scoring success path that forgets markRescoreComplete().
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const { markRescoreFlagged, markRescoreComplete } = require(path.join(REPO, 'scripts/lib/rescore-lifecycle.js'));

test('markRescoreFlagged stamps rescoreFlaggedAt', () => {
  const f = { needsRescore: true };
  markRescoreFlagged(f, '2026-08-20T12:00:00.000Z');
  assert.equal(f.rescoreFlaggedAt, '2026-08-20T12:00:00.000Z');
});

test('markRescoreFlagged defaults to now() when no timestamp is passed', () => {
  const f = {};
  markRescoreFlagged(f);
  assert.ok(f.rescoreFlaggedAt, 'a timestamp must be stamped');
  assert.ok(!Number.isNaN(Date.parse(f.rescoreFlaggedAt)), 'stamp must be a valid ISO timestamp');
});

test('markRescoreFlagged is idempotent — preserves the ORIGINAL enqueue time', () => {
  // A file re-touched by a second producer (or the same producer re-flagging
  // a still-queued file) must not have its clock reset — that would make
  // "how long has this been stuck" measure the wrong thing.
  const f = { needsRescore: true, rescoreFlaggedAt: '2026-08-01T00:00:00.000Z' };
  markRescoreFlagged(f, '2026-08-20T12:00:00.000Z');
  assert.equal(f.rescoreFlaggedAt, '2026-08-01T00:00:00.000Z');
});

test('markRescoreFlagged no-ops on non-object input', () => {
  assert.equal(markRescoreFlagged(null), null);
  assert.equal(markRescoreFlagged(undefined), undefined);
});

test('markRescoreFlagged stamps regardless of whether needsRescore is a boolean or a reason string', () => {
  // apply-audit-flags.js sets needsRescore to a reason string, not `true`.
  // The stamp must apply the same way — it keys on the enqueue moment, not
  // on the flag's value shape.
  const f = { needsRescore: 'ap-content-detected' };
  markRescoreFlagged(f, '2026-08-20T12:00:00.000Z');
  assert.equal(f.rescoreFlaggedAt, '2026-08-20T12:00:00.000Z');
});

test('markRescoreComplete clears rescoreFlaggedAt alongside needsRescore', () => {
  const f = { needsRescore: true, rescoreFlaggedAt: '2026-08-01T00:00:00.000Z', assignedScore: 91 };
  markRescoreComplete(f, '2026-08-20T12:00:00.000Z');
  assert.equal(f.needsRescore, undefined);
  assert.equal(f.rescoreFlaggedAt, undefined, 'the enqueue stamp must retire with the flag it timestamps');
  assert.equal(f.rescoreCompletedAt, '2026-08-20T12:00:00.000Z');
});

test('rescoreFlaggedAt is a PROTECTED_FIELDS entry in review-write-guard.js', () => {
  // Same rationale as needsRescore/rescoreReason directly above it in that
  // list: without protection, a producer's commit racing push-review-texts'
  // restore step would see committed HEAD (checked out before the producer
  // ran) missing the stamp and silently drop it on the next rebase — the
  // flag survives but its provenance time doesn't, reopening the exact gap
  // this fix exists to close.
  const src = fs.readFileSync(path.join(REPO, 'scripts/lib/review-write-guard.js'), 'utf8');
  const protectedFieldsMatch = src.match(/const PROTECTED_FIELDS = \[([\s\S]*?)\n\];/);
  assert.ok(protectedFieldsMatch, 'PROTECTED_FIELDS array not found — update this test if it was renamed');
  assert.ok(
    /'rescoreFlaggedAt'/.test(protectedFieldsMatch[1]),
    'rescoreFlaggedAt must be in PROTECTED_FIELDS so the enqueue stamp survives a rebase restore'
  );
});

test('audit-stuck-rescore-flags.js --fix retires rescoreFlaggedAt alongside needsRescore', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/audit-stuck-rescore-flags.js'), 'utf8');
  assert.ok(
    /delete d\.needsRescore;[\s\S]{0,80}delete d\.rescoreFlaggedAt;/.test(src),
    '--fix deletes needsRescore but not rescoreFlaggedAt — a permanently-stuck flag cleared by ' +
      '--fix would leave a dangling enqueue stamp with no flag it describes'
  );
});

test('every needsRescore producer under scripts/ calls markRescoreFlagged', () => {
  // Walk scripts/ for .js/.ts producer files (skip node_modules, tests, and
  // the lifecycle/predicate libs themselves — they define or read the
  // contract, they don't enqueue).
  const SKIP_FILES = new Set([
    'scripts/lib/rescore-lifecycle.js',
    'scripts/lib/stuck-rescore-flag.js',
    'scripts/lib/review-write-guard.js',
    'scripts/lib/rescore-queue-depth.js',
    'scripts/lib/scoring-queue-counts.js',
    'scripts/audit-stuck-rescore-flags.js',
    'scripts/check-corpus-drift.js',
    'scripts/check-progress-stalls.js',
  ]);

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|ts)$/.test(entry.name)) continue;
      if (/\.test\.(mjs|ts)$/.test(entry.name)) continue;
      files.push(full);
    }
  })(path.join(REPO, 'scripts'));

  // Two shapes producers actually use as CODE (not prose): a member
  // assignment (`data.needsRescore = true` / `d.needsRescore = 'reason'`)
  // and an object-literal key as the first token on its line
  // (`needsRescore: true,`). Anchoring on `.` / line-start deliberately
  // excludes doc-comment prose ("Sets needsRescore=true...") and log/help
  // text ("flagged with needsRescore=true") that mention the flag without
  // setting it — those aren't producers and have no assignment to guard.
  const MEMBER_ASSIGN_RE = /\.\bneedsRescore\b\s*=\s*(true\b|'[^']*'|"[^"]*")(?!\s*[=?])/g;
  const OBJECT_KEY_RE = /^[ \t]*needsRescore\s*:\s*(true\b|'[^']*'|"[^"]*")\s*,?\s*$/gm;

  const missing = [];
  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');

    for (const re of [MEMBER_ASSIGN_RE, OBJECT_KEY_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(src))) {
        const upTo = src.slice(0, match.index);
        const line = upTo.split('\n').length;
        // Look for markRescoreFlagged( within a small window around the
        // assignment — every real producer calls it within 1-3 lines (either
        // right after setting the flag, or once for a whole object literal).
        const windowStart = Math.max(0, line - 3);
        const windowEnd = Math.min(lines.length, line + 8);
        const window = lines.slice(windowStart, windowEnd).join('\n');
        if (!/markRescoreFlagged\(/.test(window)) {
          missing.push(`${rel}:${line}`);
        }
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `producer(s) set needsRescore without calling markRescoreFlagged() nearby: ${missing.join(', ')}. ` +
      'Import markRescoreFlagged from scripts/lib/rescore-lifecycle.js and call it right after setting the flag.'
  );
});
