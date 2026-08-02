import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planAutofix, runAutofix, matchOpenTask, buildCardNotes, DISPATCH_CAP } = require('./digest-autofix.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
const { extractVerifyCmd } = require('./autonomous-verify-cmd.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('planAutofix: dedups against open tasks, maps states', () => {
  const health = { errors: [{ name: 'A', message: 'a' }], warns: [{ name: 'B', message: 'b' }] };
  const tasks = [
    { id: 7, status: 'in_progress', subject: 'Fix: BSC Daily: A' },
    { id: 8, status: 'pending', subject: 'BSC Daily: B' },
  ];
  const plan = planAutofix({ health, extraIssues: [{ name: 'C', message: 'c' }], tasks });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(r => r.state), ['in-progress', 'queued', 'needs-card']);
  assert.equal(plan[0].taskId, 7);
  assert.equal(plan[1].taskId, 8);
});

test('matchOpenTask ignores completed tasks', () => {
  assert.equal(matchOpenTask([{ id: 1, status: 'completed', subject: 'BSC Daily: X' }], 'X'), null);
});

test('runAutofix dry-run: never spawns, caps dispatches at DISPATCH_CAP', () => {
  const plan = Array.from({ length: DISPATCH_CAP + 2 }, (_, i) => ({
    name: `N${i}`, message: 'm', title: `BSC Daily: N${i}`, state: 'queued', taskId: i + 1,
  }));
  const out = runAutofix({ plan, dryRun: true });
  assert.equal(out.filter(r => r.state === 'dispatched').length, DISPATCH_CAP);
  assert.equal(out.filter(r => r.state === 'queued').length, 2);
});

// ── buildCardNotes: must satisfy BOTH downstream gates ──────────────────────

test('buildCardNotes: carries every section the notion-brain card-quality gate requires, >=300 chars', () => {
  const notes = buildCardNotes({ name: 'Workflow repeat-failure: Test Suite', message: 'failing 3 days' });
  for (const section of ['## Problem', '## Evidence', '## Suggested approach', '## Acceptance criteria']) {
    assert.ok(notes.includes(section), `missing ${section}`);
  }
  assert.ok(notes.length >= 300, `notes too short for backlog gate: ${notes.length}`);
});

test('buildCardNotes: acceptance command passes the REAL safe-form gate and arms extractVerifyCmd', () => {
  // Row names with spaces, colons, punctuation — the exact shapes health-check
  // emits. The b64url token must keep each one a single safe-form-valid word.
  for (const name of ['Workflow repeat-failure: Rebuild Reviews Data', 'SEO: health', 'Credits: ScrapingDog', 'T1 Coverage (broadway)']) {
    const notes = buildCardNotes({ name, message: 'x' });
    const verify = extractVerifyCmd(notes, isSafeCheckCommand);
    assert.ok(verify.cmd, `verify not armed for "${name}": ${verify.reason}`);
    assert.match(verify.cmd, /^node scripts\/check-health-row-absent\.js --row-b64 [A-Za-z0-9_-]+$/);
    // Round-trip: the token decodes back to the exact row name.
    const token = verify.cmd.split(' ').pop();
    assert.equal(Buffer.from(token, 'base64url').toString('utf8'), name);
  }
});

test('check-health-row-absent.js: absent row exits 0, present row exits 1 (real snapshot)', () => {
  const script = path.join(__dirname, '..', 'check-health-row-absent.js');
  const snapPath = path.join(__dirname, '..', '..', 'data', 'audit', 'health-digest-snapshot.json');
  let snap;
  try { snap = require(snapPath); } catch { snap = null; }
  if (!snap || !Array.isArray(snap.warns)) return; // cloud/stub checkout — no snapshot to test against
  const fresh = (Date.now() - Date.parse(snap.generatedAt || 0)) / 36e5 <= 48;

  const run = (rowName) => {
    try {
      execFileSync('node', [script, '--row-b64', Buffer.from(rowName, 'utf8').toString('base64url')], { encoding: 'utf8' });
      return 0;
    } catch (err) { return err.status; }
  };
  const absentCode = run('__definitely-not-a-real-health-row__');
  assert.equal(absentCode, fresh ? 0 : 3);
  const realRow = [...(snap.errors || []), ...(snap.warns || [])].find(r => r && r.name);
  if (realRow && fresh) assert.equal(run(realRow.name), 1);
});

test('check-health-row-absent.js: --help and missing args exit 2 without touching anything', () => {
  const script = path.join(__dirname, '..', 'check-health-row-absent.js');
  for (const args of [['--help'], []]) {
    let code = 0;
    try { execFileSync('node', [script, ...args], { encoding: 'utf8' }); } catch (err) { code = err.status; }
    assert.equal(code, 2, `args ${JSON.stringify(args)}`);
  }
});
