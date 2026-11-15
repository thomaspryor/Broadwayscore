// BRO-7520: the Action's own card filing. A fresh visitor row must never reach the owner's email as
// "no automatic fix confirmed" in the Action path; the Mac pass is no longer the only filer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { planAutofix, runCloudFile, DISPATCH_CAP } = require('../../scripts/lib/digest-autofix.js');
const { ownerFixStatus } = require('../../scripts/lib/autonomous-email-render.js');

// Real clock: planAutofix's validFirstSeen rejects dates past Date.now(), so a fixed future NOW would null every firstSeen.
const NOW = new Date();
const ago = (d) => new Date(NOW.getTime() - d * 864e5).toISOString();
const NONE = 'no automatic fix confirmed';
const fakeFile = () => { const calls = []; return { calls, fn: (title, notes, o) => { calls.push({ title, notes, o }); return { ok: true, identifier: `BRO-${900 + calls.length}` }; } }; };
const planFor = (errors, warns = []) => planAutofix({ health: { errors, warns }, tasks: [], queued: [] });

test('a fresh visitor ERROR row is filed START-NOW as a cloud card and never renders "no automatic fix confirmed"', () => {
  const plan = planFor([{ name: 'Test UGC Features', message: 'workflow failing', firstSeen: ago(0) }]);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].title, 'BSC Daily: Test UGC Features');
  assert.equal(f.calls[0].o.startNow, true);
  assert.equal(f.calls[0].o.cloudFiled, true);
  assert.equal(plan[0].state, 'card-filed');
  assert.notEqual(ownerFixStatus({ name: 'Test UGC Features' }, plan), NONE);
});

test('without the filing step the same fresh row reads "no automatic fix confirmed" (the bug this guards)', () => {
  const plan = planFor([{ name: 'Test UGC Features', message: 'm', firstSeen: ago(0) }]);
  assert.equal(ownerFixStatus({ name: 'Test UGC Features' }, plan), NONE);
});

test('a visitor warning files on the run the email first shows it (48h settle, unknown age files), never a 3-day wait', () => {
  const plan = planFor([], [
    { name: 'Check Performance Budget', message: 'slow', firstSeen: ago(0) },
    { name: 'Check Old Thing', message: 'x', firstSeen: ago(5) },
    { name: 'Data quality: stale announced shows', message: 'x', firstSeen: '1970-01-01T00:00:00.000Z' },
  ]);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  // ago(0) is still settling (the email holds it back too), ago(5) and the 1970 seed are shown, so filed.
  assert.deepEqual(plan.map((r) => r.state), ['watching', 'card-filed', 'card-filed']);
  assert.equal(f.calls.length, 2);
  for (const r of plan) assert.notEqual(ownerFixStatus({ name: r.name }, plan), NONE);
});

test('owner-money rows are left to the Mac pass, never filed here', () => {
  const plan = planFor([], [{ name: 'Credits: ScrapingBee', message: 'low', firstSeen: ago(6) }]);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  assert.equal(f.calls.length, 0);
  assert.equal(plan[0].state, 'needs-card');
});

test('cap: at most DISPATCH_CAP new cards a run, the rest read file-next-run', () => {
  const errors = ['A one', 'B two', 'C three', 'D four', 'E five'].map((name) => ({ name, message: 'm', firstSeen: ago(0) }));
  const plan = planFor(errors);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  assert.equal(f.calls.length, DISPATCH_CAP);
  assert.equal(plan.filter((r) => r.state === 'card-filed').length, DISPATCH_CAP);
  const over = plan.filter((r) => r.state === 'file-next-run');
  assert.equal(over.length, 2);
  for (const r of plan) assert.notEqual(ownerFixStatus({ name: r.name }, plan), NONE);
  // Over-cap rows have no card: their status must never claim one.
  for (const r of over) assert.doesNotMatch(ownerFixStatus({ name: r.name }, plan), /ticket filed|has a|tracker filed|queued/);
});

test('budget: rows past the time budget are not filed', () => {
  const plan = planFor([{ name: 'A one', message: 'm', firstSeen: ago(0) }, { name: 'B two', message: 'm', firstSeen: ago(0) }]);
  let t = 0;
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: (...a) => { t += 200000; return f.fn(...a); }, now: NOW, nowMsFn: () => t, budgetMs: 150000 });
  assert.equal(f.calls.length, 1);
  assert.equal(plan[1].state, 'file-next-run');
});

test('dedup: a reattached card that is already being worked reads tracked and spends no cap slot', () => {
  const plan = planFor([{ name: 'Test UGC Features', message: 'm', firstSeen: ago(0) }]);
  runCloudFile({ plan, fileCardFn: () => ({ ok: true, identifier: 'BRO-1', existing: true, stateType: 'started' }), now: NOW });
  assert.equal(plan[0].state, 'tracked');
});

test('a failed filing reads card-failed, which the email states plainly', () => {
  const plan = planFor([{ name: 'Test UGC Features', message: 'm', firstSeen: ago(0) }]);
  runCloudFile({ plan, fileCardFn: () => ({ ok: false, identifier: null }), now: NOW });
  assert.equal(plan[0].state, 'card-failed');
});

test('the Action real-send step passes --cloud-autofix; filing is gated on the Resend verdict and never on dry-run/test-send', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/morning-digest-action.yml'), 'utf8');
  assert.match(wf, /--send-to-owner --cloud-autofix --skip-mac-local \$MODE/);
  const src = fs.readFileSync(path.join(ROOT, 'scripts/send-morning-digest.js'), 'utf8');
  assert.match(src, /const cloudAutofix = !!args\['cloud-autofix'\] && !args\['dry-run'\] && !args\['test-send'\] && !autofixOnly;/);
  assert.match(src, /const noAutofix = !!args\['no-autofix'\] \|\| !!args\['cloud-autofix'\];/);
  assert.match(src, /resendGuard && resendGuard\.verdict === 'send'\) \{\s*require\('\.\/lib\/digest-autofix\.js'\)\.runCloudFile/);
  // cloud mode never reaches the Mac fan-out or the canary
  assert.match(src, /if \(!noAutofix\) try \{\s*const \{ runAutofixCanary \}/);
});

test('cloud-mode email header says what the Action did, not "only reports"', () => {
  const { buildHtml } = require('../../scripts/send-morning-digest.js');
  const rows = [{ state: 'card-filed', title: 'BSC Daily: X broken', name: 'X broken' }];
  const sections = { health: { errors: [{ name: 'X broken', message: 'm' }], warnings: [], queued: [] } };
  const html = buildHtml({ sections, autofixRows: rows, reportOnly: 'cloud', loopDeadMsg: '' });
  assert.match(html, /got a fix card this morning/);
  assert.doesNotMatch(html, /did not start any automatic fix/);
  // review finding: never claim a card was filed when none was
  const none = buildHtml({ sections, autofixRows: [{ state: 'watching', title: 'BSC Daily: X broken', name: 'X broken' }], reportOnly: 'cloud', loopDeadMsg: '' });
  assert.doesNotMatch(none, /got a fix card this morning/);
  assert.match(none, /No new fix card was filed this morning/);
});

test('health-check passes this run\'s results to the uncarded-rows check (ordering guard)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/health-check.js'), 'utf8');
  assert.match(src, /results\.push\(\.\.\.\(await checkUncardedDigestRows\(results\)\)\)/);
});

test('a folded visitor row with a seed-dated member files at once, even when another member is young', () => {
  const plan = planFor([], [
    { name: 'Missing poster on Hamilton', message: 'm', firstSeen: '1970-01-01T00:00:00.000Z' },
    { name: 'Missing poster on Wicked', message: 'm', firstSeen: ago(0.1) },
  ]);
  const folded = plan.filter((r) => Array.isArray(r.affected));
  assert.equal(folded.length, 1);
  assert.equal(folded[0].affected.length, 2);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  assert.equal(folded[0].state, 'card-filed');
});

test('a folded visitor row whose members are all young waits like the email does', () => {
  const plan = planFor([], [
    { name: 'Missing poster on Hamilton', message: 'm', firstSeen: ago(0.2) },
    { name: 'Missing poster on Wicked', message: 'm', firstSeen: ago(0.1) },
  ]);
  const f = fakeFile();
  runCloudFile({ plan, fileCardFn: f.fn, now: NOW });
  assert.equal(f.calls.length, 0);
  assert.ok(plan.every((r) => r.state === 'watching'));
});
