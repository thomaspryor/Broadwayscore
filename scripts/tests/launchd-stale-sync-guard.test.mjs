// Test for scripts/lib/launchd-stale-sync-guard.js (BRO-1794).
// Fixtures are the ACTUAL lines found in this repo before each was fixed —
// this is a regression test against real recurrences of the bug class, not
// synthetic examples. require(), not a reimplementation (CLAUDE.md rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnsafeSyncPatterns, findUnsafeSyncPatternsInPlist } from '../lib/launchd-stale-sync-guard.js';

test('flags the old autonomous-shadow inline ff-only swallow (plist)', () => {
  const plist = `
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd /Users/tompryor/Broadwayscore &amp;&amp; { git fetch origin main --quiet &amp;&amp; git merge --ff-only origin/main --quiet || echo "[shadow] ff-only update skipped (dirty/diverged checkout) — running with local code"; } &amp;&amp; exec node scripts/autonomous-shadow-run.js --limit 5</string>
    </array>`;
  const findings = findUnsafeSyncPatternsInPlist(plist);
  assert.equal(findings.length, 1);
  assert.match(findings[0].text, /--ff-only/);
});

test('does not flag the fixed sync-audit-checkout.sh call (plist)', () => {
  const plist = `
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd /Users/tompryor/Broadwayscore &amp;&amp; SYNC_TAG=shadow bash scripts/lib/sync-audit-checkout.sh &amp;&amp; exec node scripts/autonomous-shadow-run.js --limit 5</string>
    </array>`;
  assert.deepEqual(findUnsafeSyncPatternsInPlist(plist), []);
});

test('does not flag a plist comment that quotes the bad pattern as documentation', () => {
  // predispatch-queue-audit.plist's own header literally quotes the old
  // pattern to explain what task #1563 fixed — the guard must not self-flag
  // documentation, only executable <string> content.
  const plist = `
    <!-- Task #1563: was missing this tracked template entirely and ran off
         a hand-maintained ~/Library/LaunchAgents copy using the old inline
         \`git merge --ff-only || echo "skipped"\` pattern, which silently lets
         the job run on stale code whenever data/audit/* has local edits. -->
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd /Users/tompryor/Broadwayscore &amp;&amp; SYNC_TAG=predispatch-queue-audit bash scripts/lib/sync-audit-checkout.sh &amp;&amp; exec node scripts/predispatch-queue-audit.js</string>
    </array>`;
  assert.deepEqual(findUnsafeSyncPatternsInPlist(plist), []);
});

test('flags the old weekly-retro.sh ff-only swallow (shell)', () => {
  const sh = `set -euo pipefail\n# Pull latest\ngit pull --ff-only origin main >> "$LOG" 2>&1 || true\n`;
  const findings = findUnsafeSyncPatterns(sh);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

test('does not flag the fixed weekly-retro.sh sync-audit-checkout call (shell)', () => {
  const sh = `set -euo pipefail\nSYNC_TAG=weekly-retro bash scripts/lib/sync-audit-checkout.sh >> "$LOG" 2>&1\n`;
  assert.deepEqual(findUnsafeSyncPatterns(sh), []);
});

test('flags sync-review-texts.sh / simulate-opening-night-full.sh style rebase swallow', () => {
  const sh = `git pull --rebase origin main -q 2>/dev/null || true\n`;
  const findings = findUnsafeSyncPatterns(sh);
  assert.equal(findings.length, 1);
});

test('flags the -C <dir> form (sync-memory-to-repo.sh / refresh-drafts.sh style)', () => {
  const sh = `git -C "$REPO" pull --rebase --autostash -q origin main 2>/dev/null || true\n`;
  const findings = findUnsafeSyncPatterns(sh);
  assert.equal(findings.length, 1);
});

test('does not flag a properly-guarded pull --rebase (if ! ... then abort)', () => {
  const sh = `if ! git pull --rebase --autostash --quiet; then\n  echo "ABORTING" >&2\n  exit 1\nfi\n`;
  assert.deepEqual(findUnsafeSyncPatterns(sh), []);
});

test('does not flag a commented-out example line', () => {
  const sh = `# old pattern (do not use): git pull --ff-only origin main || true\n`;
  assert.deepEqual(findUnsafeSyncPatterns(sh), []);
});

test('waiver comment on the same line suppresses a flag', () => {
  const sh = `git pull --ff-only origin main >> "$LOG" 2>&1 || true  # launchd-stale-sync-ok: reviewed, this path has its own retry loop below\n`;
  assert.deepEqual(findUnsafeSyncPatterns(sh), []);
});

test('waiver comment works in the plist form too', () => {
  const plist = `<string>git merge --ff-only origin/main --quiet || echo "skip"  # launchd-stale-sync-ok: reviewed 2026-08-21</string>`;
  assert.deepEqual(findUnsafeSyncPatternsInPlist(plist), []);
});

test('does not flag sync-audit-checkout.sh itself (structured if/then, no || swallow)', () => {
  const sh = `if git merge --ff-only origin/main --quiet 2>/dev/null; then\n  clear_refused_snapshot\n  exit 0\nfi\n`;
  assert.deepEqual(findUnsafeSyncPatterns(sh), []);
});
