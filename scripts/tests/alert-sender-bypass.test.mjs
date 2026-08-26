/**
 * alert-sender-bypass.test.mjs — BRO-1699 acceptance.
 *
 * The card's bar: the alert-sender audit reports ZERO direct-bypass call
 * sites (sendAlert(email:true) calls that skip owner-alert-router.js's
 * ACTION-only policy + ledger dedup). Requires the REAL exported scanner
 * (scripts/audit-alert-senders.js's scanFile/buildDirectCounts) per CLAUDE.md
 * rule 15 — never re-lists the regex patterns here, so a future direct
 * sendAlert(email:true) bypass fails this test the same way it fails the
 * scanner, instead of two copies silently drifting apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { scanFile, buildDirectCounts } = require(path.join(REPO, 'scripts/audit-alert-senders.js'));

const SCAN_DIRS = ['scripts', '.github/workflows'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

function walk(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

function collectFindings() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO, dir), files);
  let all = [];
  for (const absPath of files) {
    const relPath = path.relative(REPO, absPath).split(path.sep).join('/');
    if (relPath.endsWith('.test.mjs') || relPath.endsWith('.test.js')) continue;
    if (relPath === 'scripts/audit-alert-senders.js') continue;
    all = all.concat(scanFile(absPath, relPath));
  }
  return all;
}

test('alert-sender audit reports zero direct-bypass call sites', () => {
  const findings = collectFindings();
  const counts = buildDirectCounts(findings);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(
    total,
    0,
    `${total} direct sendAlert(email:true) bypass(es) of owner-alert-router found: ` +
      `${JSON.stringify(counts)} — route through routeAlert() (scripts/lib/owner-alert-router.js) instead.`
  );
});

test('the two historical BRO-1699 bypass sites are migrated onto routeAlert()', () => {
  const broadcastYml = fs.readFileSync(
    path.join(REPO, '.github/workflows/opening-night-broadcast.yml'),
    'utf8'
  );
  const pollerJs = fs.readFileSync(path.join(REPO, 'scripts/opening-night-poller.js'), 'utf8');

  assert.match(broadcastYml, /routeAlert/, 'opening-night-broadcast.yml no longer calls routeAlert()');
  assert.match(pollerJs, /routeAlert/, 'opening-night-poller.js no longer calls routeAlert()');
});

test('both migrated conditionKeys stay on the page-worthy allowlist (no silent digest downgrade)', () => {
  // Ship-check finding (BRO-1699): leaving a migrated conditionKey off this
  // allowlist silently downgrades disposition:'human' to the digest, which
  // regressed real-time paging for the SERP-burst tripwire on the first pass
  // (its own severity rationale argues a 24h-late digest is inadequate). This
  // locks both migrated keys in so a future edit to page-worthy-alerts.js
  // can't quietly re-introduce that regression.
  const { PAGE_WORTHY_PREFIXES, PAGE_WORTHY_CONDITION_KEYS } = require(
    path.join(REPO, 'scripts/lib/page-worthy-alerts.js')
  );
  assert.ok(
    PAGE_WORTHY_PREFIXES.includes('broadcast:overdue:'),
    "'broadcast:overdue:' missing from PAGE_WORTHY_PREFIXES"
  );
  assert.ok(
    PAGE_WORTHY_CONDITION_KEYS.has('serp-burst:tripwire'),
    "'serp-burst:tripwire' missing from PAGE_WORTHY_CONDITION_KEYS"
  );
});
