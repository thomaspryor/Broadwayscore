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
const { readSyncRefused } = require('../../scripts/lib/digest-snapshots.js');
const { buildHtml, autofixShouldDryRun } = require('../../scripts/send-morning-digest.js');

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
test('autofixShouldDryRun: syncRefused forces dryRun even when --dry-run was not passed', () => {
  assert.equal(autofixShouldDryRun({ dryRun: false, syncRefused: null }), false);
  assert.equal(
    autofixShouldDryRun({ dryRun: false, syncRefused: { count: 1, bannerText: 'x', items: [] } }),
    true,
  );
  assert.equal(autofixShouldDryRun({ dryRun: true, syncRefused: null }), true);
  assert.equal(
    autofixShouldDryRun({ dryRun: true, syncRefused: { count: 1, bannerText: 'x', items: [] } }),
    true,
  );
});
