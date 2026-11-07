// BRO-5146 guard: the Notion-era tools retired by this card stay retired, and
// the live shared code they used to sit next to keeps loading.
//
// - scripts/backlog-drain.js (Notion dispatcher CLI), its test and its launchd
//   plist are deleted; no workflow or plist may invoke the CLI again.
//   scripts/lib/backlog-drain.js is LIVE (digest-autofix, dispatch-watchdog-core,
//   linear-drain-parked require it) and must stay.
// - scripts/autonomous-email.js builds no approve/reject links:
//   /api/autonomous-action answers 410 for those actions (BRO-4718).
// - data/audit/card-verifiability.json (the Notion report) is untracked and
//   card-verifiability-audit.yml no longer git-adds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const DELETED = [
  'scripts/backlog-drain.js',
  'scripts/backlog-drain.test.mjs',
  'scripts/launchd/com.broadwayscore.backlog-drain.plist',
];

// Matches an invocation/path reference to the retired CLI, but not the live
// shared lib (scripts/lib/backlog-drain.js) or its ledger/metric file names.
const CLI_REF = /(^|[^/\w-])scripts\/backlog-drain\.js|com\.broadwayscore\.backlog-drain\b/;

function listDir(rel, re) {
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(rel, f));
}

test('retired CLI, its test and its launchd plist are gone', () => {
  for (const f of DELETED) assert.equal(existsSync(join(ROOT, f)), false, `${f} should be deleted`);
});

test('no workflow or launchd plist references the retired CLI', () => {
  const files = [
    ...listDir('.github/workflows', /\.ya?ml$/),
    ...listDir('scripts/launchd', /\.plist$/),
  ];
  assert.ok(files.length > 10, `scan looks truncated (${files.length} files)`);
  const offenders = files.filter((f) => CLI_REF.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, [], `still reference scripts/backlog-drain.js: ${offenders.join(', ')}`);
});

test('CLI_REF detector: catches the CLI, ignores the shared lib', () => {
  assert.ok(CLI_REF.test("- 'scripts/backlog-drain.js'"));
  assert.ok(CLI_REF.test('exec node scripts/backlog-drain.js'));
  assert.ok(CLI_REF.test('<string>com.broadwayscore.backlog-drain</string>'));
  assert.equal(CLI_REF.test("require('./lib/backlog-drain.js')"), false);
  assert.equal(CLI_REF.test('scripts/lib/backlog-drain.js'), false);
  assert.equal(CLI_REF.test('/data/audit/backlog-drain-ledger.jsonl'), false);
});

test('shared lib scripts/lib/backlog-drain.js still loads with its exported constants', () => {
  const lib = require('../lib/backlog-drain.js');
  assert.equal(typeof lib.computeSpendCircuitBreaker, 'function');
  assert.equal(typeof lib.DEFAULT_CONCURRENCY_CAP, 'number');
  assert.equal(typeof lib.DEFAULT_SPEND_THRESHOLD_USD, 'number');
  // The live requirers load too (each requires the lib at module top level).
  for (const m of ['../lib/digest-autofix.js', '../lib/dispatch-watchdog-core.js']) {
    assert.doesNotThrow(() => require(m), `${m} must still load`);
  }
});

test('autonomous-email.js builds no approve/reject action URLs', () => {
  const src = readFileSync(join(ROOT, 'scripts/autonomous-email.js'), 'utf8');
  assert.equal(/\bapproveUrl\s*:/.test(src), false, 'approveUrl is still constructed');
  assert.equal(/\brejectUrl\s*:/.test(src), false, 'rejectUrl is still constructed');
  assert.equal(/buildActionUrl\s*\(/.test(src), false, 'buildActionUrl is still called');
});

test('renderer renders an item without approve/reject URLs and emits no empty links', () => {
  const { renderEmail } = require('../lib/autonomous-email-render.js');
  const out = renderEmail({
    items: [{ name: 'Some pass card', branch: 'auto/x', usd: 1, checks: ['tsc'] }],
    stats: { runId: null, tonight: { usd: 0, byModel: {} }, week: { usd: 0 }, paceMonthlyUSD: null }, config: {},
  });
  const html = typeof out === 'string' ? out : out.html;
  assert.ok(html.includes('Some pass card'));
  assert.equal(html.includes('href="undefined"'), false);
  assert.equal(html.includes('href=""'), false);
  assert.equal(/>Approve<\/a>/.test(html), false);
});

test('data/audit/card-verifiability.json is untracked and no workflow git-adds it', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'data/audit/card-verifiability.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(tracked.trim(), '', 'Notion report is still tracked');
  const linear = execFileSync('git', ['ls-files', '--', 'data/audit/card-verifiability-linear.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(linear.trim(), 'data/audit/card-verifiability-linear.json', 'the live Linear report must stay tracked');
  const offenders = listDir('.github/workflows', /\.ya?ml$/)
    .filter((f) => /git add[^\n]*data\/audit\/card-verifiability\.json/.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, []);
});
