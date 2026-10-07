// Task #1818: com.broadwayscore.morning-digest.plist chained
// `SYNC_TAG=digest bash scripts/lib/sync-audit-checkout.sh && exec node
// scripts/send-morning-digest.js --send-to-owner`. sync-audit-checkout.sh
// exits 1 on a blocked sync and writes data/audit/sync-refused-<tag>.json;
// send-morning-digest.js's readSyncRefused() is the ONLY reader of that
// file. The `&&` meant a refusal silently killed the one email that exists
// to report refusals — a circular alert. Fix: `;` instead of `&&` before the
// final `exec` in THIS plist only (it is read-only reporting and the sole
// reader of its own guard's refusal file); the mutating sibling jobs
// (backlog-drain/autonomous-shadow/predispatch-queue-audit) must keep `&&`
// and fail closed. Second-opinion adversarial follow-up: letting the digest
// run at all on a refused checkout must not also let its MUTATING side
// effects (runAutofix/runAutofixCanary — real Linear card filing + real
// headless job dispatch) act on untrusted code; autofixShouldDryRun() is the
// guard that forces those into dry-run whenever syncRefused is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readSyncRefused, SYNC_REFUSED_READ_FAILED } = require('../../scripts/lib/digest-snapshots.js');
const { buildHtml, autofixShouldDryRun, DIGEST_SYNC_TAG } = require('../../scripts/send-morning-digest.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCHD_DIR = path.join(REPO_ROOT, 'scripts', 'launchd');

// Reads a plist's ProgramArguments bash -c string and returns the plain-text
// (XML-entity-decoded) separator between the sync-audit-checkout.sh call and
// the final `exec` — the raw file text carries `&amp;&amp;`, never `&&`, so a
// regex matched against the raw text would never see `&&` even on a plist
// that still uses it (the exact false-negative the second-opinion review
// flagged). Decode entities BEFORE matching.
function syncGateSeparator(plistFile) {
  const raw = fs.readFileSync(path.join(LAUNCHD_DIR, plistFile), 'utf8');
  const decoded = raw.replace(/&amp;/g, '&');
  // Anchor on the literal `-c` arg's sibling <string> (the actual bash
  // command passed to `/bin/bash -c`), not a bare text search for
  // "sync-audit-checkout.sh" — that phrase also appears in prose inside
  // these plists' header comments, ahead of the real ProgramArguments.
  const cmdMatch = decoded.match(/<string>-c<\/string>\s*<string>([^<]*)<\/string>/);
  assert.ok(cmdMatch, `${plistFile}: could not find the bash -c command string`);
  const command = cmdMatch[1];
  const m = command.match(/sync-audit-checkout\.sh(.*?)exec /);
  assert.ok(m, `${plistFile}: command has no sync-audit-checkout.sh ... exec chain: ${command}`);
  return m[1].trim();
}

test('morning-digest.plist: sync-audit-checkout.sh refusal does NOT block the exec (semicolon, not &&)', () => {
  const sep = syncGateSeparator('com.broadwayscore.morning-digest.plist');
  assert.equal(sep, ';', `expected ';' between sync-audit-checkout.sh and exec, got: ${JSON.stringify(sep)}`);
});

test('mutating sibling plists still fail closed (&& unchanged)', () => {
  for (const file of [
    'com.broadwayscore.backlog-drain.plist',
    'com.broadwayscore.autonomous-shadow.plist',
    'com.broadwayscore.predispatch-queue-audit.plist',
  ]) {
    const sep = syncGateSeparator(file);
    assert.equal(sep, '&&', `${file}: expected '&&' (must stay fail-closed), got: ${JSON.stringify(sep)}`);
  }
});

test('refuse-then-still-report: a sync-refused snapshot renders the "Launchd sync blocked" email block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-sync-refused-test-'));
  fs.writeFileSync(path.join(dir, 'sync-refused-digest.json'), JSON.stringify({
    tag: 'digest',
    at: '2026-08-20T11:30:00.000Z',
    reason: 'dirty-outside-audit',
    behindCount: 4,
    dirtyFiles: ['scripts/lib/some-wip-file.js'],
  }));

  const syncRefused = readSyncRefused({ auditDir: dir });
  assert.ok(syncRefused, 'readSyncRefused should surface the written snapshot');

  const html = buildHtml({
    sections: { syncRefused },
    now: new Date('2026-08-20T12:00:00Z'),
  });

  assert.match(html, /Launchd sync blocked \(stale checkout\)/);
  assert.match(html, /dirty-outside-audit/);
  assert.match(html, /digest/);
});

// Letting the digest run on a refused/stale checkout (the fix above) must
// NOT also let its mutating side effects (runAutofix/runAutofixCanary —
// real Linear card filing + real headless dispatch) run off untrusted code.
// autofixShouldDryRun is the single guard main() relies on for that.
test('autofixShouldDryRun: the digest\'s OWN refusal forces dryRun even when --dry-run was not passed', () => {
  assert.equal(autofixShouldDryRun({ dryRun: false, syncRefused: null }), false);
  assert.equal(
    autofixShouldDryRun({ dryRun: false, syncRefused: { count: 1, tags: ['digest'], unreadable: 0 } }),
    true,
  );
  assert.equal(autofixShouldDryRun({ dryRun: true, syncRefused: null }), true);
  assert.equal(
    autofixShouldDryRun({ dryRun: true, syncRefused: { count: 1, tags: ['digest'], unreadable: 0 } }),
    true,
  );
});

// BRO-3393 — the bug this whole guard had. readSyncRefused() globs
// data/audit/sync-refused-*.json across EVERY launchd tag, while
// sync-audit-checkout.sh's clear_refused_snapshot() removes only its OWN
// tag's file. With the old `!!syncRefused`, one chronically-failing sibling
// job disabled the digest's auto-fix indefinitely: 6 auto-dispatch rows in
// data/audit/digest-autofix-ledger.jsonl across 31 days, on 2 days, while the
// digest itself sent on all 34.
test('autofixShouldDryRun: a SIBLING job\'s refusal must NOT disable the digest\'s auto-fix', () => {
  assert.equal(
    autofixShouldDryRun({
      dryRun: false,
      syncRefused: { count: 2, tags: ['linear-drain-parked', 'predispatch-queue-audit'], unreadable: 0 },
    }),
    false,
    "a sibling's stale snapshot says nothing about whether THIS process's checkout is current",
  );
  assert.equal(
    autofixShouldDryRun({
      dryRun: false,
      syncRefused: { count: 3, tags: ['linear-drain-parked', 'digest', 'predispatch-queue-audit'], unreadable: 0 },
    }),
    true,
    'own tag among siblings still forces dry-run',
  );
});

test('autofixShouldDryRun: fails CLOSED when OUR OWN refusal snapshot is unreadable', () => {
  // A truncated sync-refused-digest.json may say we refused, and readSyncRefused
  // names it by FILENAME rather than dropping it — dropping it is how it would
  // have read as "nobody refused" and let real card filing and headless
  // dispatch run against an untrusted checkout.
  assert.equal(
    autofixShouldDryRun({ dryRun: false, syncRefused: { count: 0, tags: [], unreadable: 1, unreadableTags: ['digest'] } }),
    true,
  );
  // A caller that predates the `tags` field cannot answer the question at all.
  assert.equal(
    autofixShouldDryRun({ dryRun: false, syncRefused: { count: 1, bannerText: 'x', items: [] } }),
    true,
  );
});

// Ship-check finding, BRO-3393: a single global "something was unreadable"
// counter would have re-created the very bug this change fixes. Only the
// owning job ever clears its own snapshot file, so one corrupt SIBLING file
// would suppress the digest's auto-fix indefinitely. The unreadable set is
// keyed by the tag in the FILENAME so a sibling's garbage stays a sibling's
// problem.
test('autofixShouldDryRun: a corrupt SIBLING snapshot must not suppress the digest forever', () => {
  assert.equal(
    autofixShouldDryRun({
      dryRun: false,
      syncRefused: { count: 0, tags: [], unreadable: 1, unreadableTags: ['linear-drain-parked'] },
    }),
    false,
  );
  assert.equal(
    autofixShouldDryRun({
      dryRun: false,
      syncRefused: { count: 1, tags: ['predispatch-queue-audit'], unreadable: 1, unreadableTags: ['digest'] },
    }),
    true,
    'our own unreadable snapshot still wins over a readable sibling',
  );
});

// Ship-check finding, BRO-3393: ownTag must not be readable from the
// environment. "Is THIS checkout trustworthy" cannot be a question whose
// answer any caller can set — `SYNC_TAG=shadow node scripts/send-morning-
// digest.js` would otherwise ignore a live digest refusal and dispatch anyway.
test('autofixShouldDryRun: SYNC_TAG in the environment cannot talk the guard out of a real refusal', () => {
  const prev = process.env.SYNC_TAG;
  process.env.SYNC_TAG = 'shadow';
  try {
    assert.equal(
      autofixShouldDryRun({ dryRun: false, syncRefused: { count: 1, tags: ['digest'], unreadable: 0, unreadableTags: [] } }),
      true,
      'a hostile or stale SYNC_TAG must not disable the guard',
    );
  } finally {
    if (prev === undefined) delete process.env.SYNC_TAG; else process.env.SYNC_TAG = prev;
  }
});

// Ship-check finding, BRO-3393: the catch around readSyncRefused() used to
// leave sections.syncRefused undefined, which autofixShouldDryRun read as
// "nobody refused" — so a thrown read, the single most ambiguous state there
// is, was the one path that let real card filing and headless dispatch run
// with NO freshness evidence at all.
test('autofixShouldDryRun: an unreadable refusal DIRECTORY holds auto-fix in dry-run', () => {
  assert.equal(SYNC_REFUSED_READ_FAILED.tags, null, 'tags: null is what makes the guard hold');
  assert.equal(autofixShouldDryRun({ dryRun: false, syncRefused: SYNC_REFUSED_READ_FAILED }), true);
});

test('readSyncRefused: a missing audit dir is still "no refusals", only an unreadable one fails closed', () => {
  // A genuinely absent directory is a fresh checkout with nothing to report —
  // failing closed on it would permanently dry-run any clone that has not run
  // a sync job yet.
  assert.equal(readSyncRefused({ auditDir: '/no/such/dir/at/all' }), null);
});

test('the tag the plist EXPORTS is the constant autofixShouldDryRun defaults to', () => {
  // sync-audit-decision.js:24-27's anti-drift rule, applied WITHOUT letting the
  // environment decide a security question (ship-check finding, BRO-3393):
  // DIGEST_SYNC_TAG is a constant, and this test is what stops it drifting from
  // the tag the plist actually runs the gate under. The plist `export` is the
  // machine-readable declaration this assertion reads.
  const raw = fs.readFileSync(path.join(LAUNCHD_DIR, 'com.broadwayscore.morning-digest.plist'), 'utf8');
  const decoded = raw.replace(/&amp;/g, '&');
  const cmdMatch = decoded.match(/<string>-c<\/string>\s*<string>([^<]*)<\/string>/);
  assert.ok(cmdMatch, 'could not find the bash -c command string');
  const tagMatch = cmdMatch[1].match(/export SYNC_TAG=([A-Za-z0-9_-]+)/);
  assert.ok(tagMatch, `morning-digest.plist must EXPORT SYNC_TAG so send-morning-digest.js can read it: ${cmdMatch[1]}`);
  assert.equal(tagMatch[1], DIGEST_SYNC_TAG,
    `the plist runs the sync gate as SYNC_TAG=${tagMatch[1]}, but the digest checks for refusals under '${DIGEST_SYNC_TAG}' — they must be the same string`);
  assert.equal(
    autofixShouldDryRun({ dryRun: false, syncRefused: { count: 1, tags: [tagMatch[1]], unreadable: 0, unreadableTags: [] } }),
    true,
    'a refusal written under the plist\'s own tag must force dry-run',
  );
});
