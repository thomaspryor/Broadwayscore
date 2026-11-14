// BRO-7495 Phase 2: CI before/after auto-ship decisions. Every test require()s the real code (CLAUDE.md 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const vci = require('./visual-ci.js');
const va = require('./visual-approval.js');
const link = require('../../src/lib/owner-decision-link.js');
const qp = require('./owner-decision-quiet-period.js');
const land = require('../visual-approval-land.js');
const shadow = require('../visual-shadow-report.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const S = 'test-secret';
const PATCH = 'a'.repeat(40);
const VERDICT = 'b'.repeat(16);
const BASE = 'd'.repeat(40);
const ON = { VISUAL_AUTO_SHIP: 'on' };
const AFTER = Date.parse('2026-11-20T00:00:00Z');
const BEFORE = Date.parse('2026-11-18T00:00:00Z');
const WIDTHS = [360, 414, 768, 1024, 1440];
const verdict = { paths: ['/my-shows?mock=1&tab=diary'], elements: ['[data-testid="x"]'] };
const plan = () => vci.planCapture({ changedFiles: ['src/components/my-shows/Row.tsx'], verdict, diffText: '+<div/>' });
const allSame = (pl) => vci.expectedPairs(pl, WIDTHS).map((p) => ({ ...p, status: 'same' }));
const good = (pl) => ({ plan: pl, pairs: allSame(pl), canaryOk: true, elementsFound: pl.elements, widths: WIDTHS });

test('flag: needs the variable exactly on AND the date passed', () => {
  assert.equal(vci.autoShipOn(ON, AFTER), true);
  assert.equal(vci.autoShipOn(ON, BEFORE), false, 'before 2026-11-19 never');
  assert.equal(vci.autoShipOn({}, AFTER), false);
  assert.equal(vci.autoShipOn({ VISUAL_AUTO_SHIP: 'off' }, AFTER), false);
  assert.equal(vci.autoShipOn({ VISUAL_AUTO_SHIP: '1' }, AFTER), false);
});

test('planCapture: scripts, workflows, config, api and non-visual diffs cannot be proven by pictures', () => {
  for (const f of ['.github/workflows/x.yml', 'scripts/a.js', 'config/x.json', 'next.config.js', 'package.json', 'src/app/api/x/route.ts']) {
    assert.ok(vci.planCapture({ changedFiles: ['src/components/A.tsx', f], verdict, diffText: '' }).blocked, f);
  }
  assert.ok(vci.planCapture({ changedFiles: ['data/shows.json'], verdict, diffText: '' }).blocked);
  assert.ok(vci.planCapture({ changedFiles: ['src/components/A.tsx'], verdict: { paths: ['/x'], elements: [] }, diffText: '' }).blocked, 'no element to look for');
  assert.ok(vci.planCapture({ changedFiles: ['src/components/A.tsx'], verdict: { paths: [], elements: ['a'] }, diffText: '' }).blocked, 'no page');
  assert.ok(vci.planCapture({ changedFiles: ['src/components/A.tsx'], verdict, diffText: '+<time dateTime="x">' }).blocked, 'masked region edit');
  assert.equal(vci.planCapture({ changedFiles: [], verdict, diffText: '' }).blocked, 'no changed files');
});

test('planCapture: ugc files add the interactive states, css adds the floor pages', () => {
  const p = plan();
  assert.ok(p.routes.includes('/test/rating-editor-fixture') && p.routes.includes('/my-shows?mock=1&tab=diary'));
  assert.ok(p.states['/my-shows?mock=1&tab=diary'].length >= 1);
  const c = vci.planCapture({ changedFiles: ['src/app/globals.css'], verdict, diffText: '' });
  assert.ok(c.routes.includes('/') && c.routes.includes('/browse'));
});

test('evaluate: identical only when everything matched; any single doubt is not identical', () => {
  const pl = plan();
  assert.equal(vci.evaluate(good(pl)).outcome, 'identical');
  const oneDiff = good(pl); oneDiff.pairs[3] = { ...oneDiff.pairs[3], status: 'different', reason: 'x' };
  assert.equal(vci.evaluate(oneDiff).outcome, 'different');
  const oneErr = good(pl); oneErr.pairs[0] = { ...oneErr.pairs[0], status: 'error', reason: 'timeout' };
  assert.equal(vci.evaluate(oneErr).outcome, 'incomplete');
  const missing = good(pl); missing.pairs.pop();
  assert.equal(vci.evaluate(missing).outcome, 'incomplete');
  assert.equal(vci.evaluate({ ...good(pl), canaryOk: false }).outcome, 'incomplete');
  assert.equal(vci.evaluate({ ...good(pl), canaryOk: undefined }).outcome, 'incomplete');
  assert.equal(vci.evaluate({ ...good(pl), elementsFound: [] }).outcome, 'incomplete', 'the changed element never rendered');
  assert.equal(vci.evaluate({ plan: { blocked: 'x' }, widths: WIDTHS }).outcome, 'blocked');
  assert.equal(vci.evaluate({ ...good(pl), pairs: null }).outcome, 'incomplete');
});

test('markers: signed, bound to patch and outcome, unforgeable without the secret, expire', () => {
  const body = vci.buildCiComment({ secret: S, id: 'BRO-7', patch: PATCH, outcome: 'identical', base: BASE, digest: 'e'.repeat(16), reasons: [], armed: true });
  const node = (b, t = AFTER) => ({ body: b, createdAt: new Date(t).toISOString() });
  assert.equal(vci.findCiResult([node(body)], S, 'BRO-7', PATCH, AFTER).outcome, 'identical');
  assert.equal(vci.findCiResult([node(body)], 'other', 'BRO-7', PATCH, AFTER), null, 'wrong secret');
  assert.equal(vci.findCiResult([node(body)], S, 'BRO-8', PATCH, AFTER), null, 'another card');
  assert.equal(vci.findCiResult([node(body)], S, 'BRO-7', 'f'.repeat(40), AFTER), null, 'another patch');
  assert.equal(vci.findCiResult([node(body)], S, 'BRO-7', PATCH, AFTER + vci.CI_TTL_MS + 1000), null, 'expired');
  assert.equal(vci.findCiResult([node(body.replace(/VQK[0-9a-f]+/, 'VQK' + '0'.repeat(32)))], S, 'BRO-7', PATCH, AFTER), null, 'copied text, wrong mac');
  const diffBody = body.replace('outcome=identical', 'outcome=different');
  assert.equal(vci.findCiResult([node(diffBody)], S, 'BRO-7', PATCH, AFTER), null, 'edited outcome breaks the mac');
});

test('planAuto: every guard blocks; only a clean identical result ships', () => {
  const ci = { outcome: 'identical', base: BASE, digest: 'e'.repeat(16), at: AFTER };
  const ok = { ci, flagOn: true, emailed: false, rejected: false, holdFiles: ['src/components/A.tsx'], driftFiles: ['data/shows.json'] };
  assert.equal(vci.planAuto(ok).auto, true);
  assert.equal(vci.planAuto({ ...ok, flagOn: false }).auto, false);
  assert.equal(vci.planAuto({ ...ok, ci: null }).auto, false);
  assert.equal(vci.planAuto({ ...ok, ci: { ...ci, outcome: 'different' } }).auto, false);
  assert.equal(vci.planAuto({ ...ok, emailed: true }).auto, false);
  assert.equal(vci.planAuto({ ...ok, rejected: true }).auto, false, 'owner reject outranks');
  assert.equal(vci.planAuto({ ...ok, holdFiles: ['scripts/x.js'] }).auto, false);
  assert.equal(vci.planAuto({ ...ok, driftFiles: ['src/components/B.tsx'] }).auto, false, 'main moved');
  assert.equal(vci.planAuto({ ...ok, driftFiles: null }).auto, false, 'unreadable git');
  assert.equal(vci.planAuto({ ...ok, holdFiles: null }).auto, false, 'unreadable hold diff must not skip the never-auto check');
});

test('ciHoldReason: only while armed, only while a check can still clear the ask', () => {
  const base = { flagOn: true, hasVisualBlock: true, ci: null, askedAt: AFTER - 10 * 60000, now: AFTER, emailed: false };
  assert.equal(vci.ciHoldReason(base).reason, 'visual-check-pending');
  assert.equal(vci.ciHoldReason({ ...base, flagOn: false }), null, 'flag off: identical to today');
  assert.equal(vci.ciHoldReason({ ...base, askedAt: AFTER - 3 * 3600000 }), null, 'check overdue: ask the owner');
  assert.equal(vci.ciHoldReason({ ...base, ci: { outcome: 'different' } }), null);
  assert.equal(vci.ciHoldReason({ ...base, ci: { outcome: 'identical' } }).reason, 'auto-shipping');
  assert.equal(vci.ciHoldReason({ ...base, emailed: true }), null);
});

const desc = () => va.buildBlock({ what: 'the diary row', patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-7', evidence: [{ label: 'Row', url: `https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${'c'.repeat(40)}/home.png` }], summary: 'ok' });
const ciComment = (t, outcome = 'identical') => ({ id: 'k', body: vci.buildCiComment({ secret: S, id: 'BRO-7', patch: PATCH, outcome, base: BASE, digest: 'e'.repeat(16), reasons: [], armed: true }), createdAt: new Date(t).toISOString() });
const ask = (t) => ({ id: 'a', body: 'Asked the owner to look at the diary row.', createdAt: new Date(t).toISOString() });
const card = (comments) => ({ identifier: 'BRO-7', title: 'q', description: desc(), comments: { nodes: comments } });

test('lander planCard: auto only when the caller proved it, and the owner tap still wins', () => {
  const c = card([ask(AFTER - 3600000), ciComment(AFTER - 1800000)]);
  assert.equal(land.planCard(c, S, AFTER, null, null, false).action, 'wait');
  assert.equal(land.planCard(c, S, AFTER, null, null, true).action, 'land');
  assert.equal(land.planCard(c, S, AFTER, null, null, true).auto, true);
  assert.equal(land.planCard(c, S, AFTER, 'f'.repeat(40), null, true).action, 'void', 'hold branch moved on');
  assert.equal(land.planCard(c, S, AFTER, PATCH, null, true).action, 'land');
});

test('lander autoDecision: flag off, no result, different result all mean no auto', () => {
  const c = card([ask(AFTER - 3600000), ciComment(AFTER - 1800000)]);
  assert.equal(land.autoDecision(c, S, {}, AFTER).auto, false, 'flag off');
  assert.equal(land.autoDecision(c, S, ON, BEFORE).auto, false, 'before the date');
  assert.equal(land.autoDecision(card([ask(AFTER - 3600000)]), S, ON, AFTER).auto, false, 'no CI result');
  assert.equal(land.autoDecision(card([ciComment(AFTER - 1800000, 'different')]), S, ON, AFTER).auto, false);
});

test('emailer hold: flag off never holds; armed holds a fresh ask, releases an overdue one', () => {
  const dec = { identifier: 'BRO-7', question: 'q', title: 'q' };
  const fresh = card([ask(AFTER - 10 * 60000)]);
  const noHold = qp.holdReason(fresh, dec, { secret: S, now: AFTER, env: {} });
  assert.ok(!noHold || noHold.reason !== 'visual-check-pending');
  assert.equal(qp.holdReason(fresh, dec, { secret: S, now: AFTER, env: ON }).reason, 'visual-check-pending');
  const overdue = card([ask(AFTER - 4 * 3600000)]);
  const h = qp.holdReason(overdue, dec, { secret: S, now: AFTER, env: ON });
  assert.ok(!h || h.reason !== 'visual-check-pending');
});

test('CI and auto-ship comments are not card activity, and are scrubbed from email text', () => {
  const issue = card([ciComment(AFTER - 60000), { id: 'm', body: `Auto-shipped.\n\n${va.MARK.auto}${'1'.repeat(16)}`, createdAt: new Date(AFTER - 30000).toISOString() }]);
  assert.equal(qp.lastActivityAt(issue), null);
  assert.equal(va.classifyStatus(desc(), [ask(AFTER - 100000), { id: 'm', body: `${va.MARK.auto}${'1'.repeat(16)}\n${va.MARK.landed}${'1'.repeat(16)}`, createdAt: new Date(AFTER).toISOString() }]), 'auto');
  assert.equal(va.classifyStatus(desc(), [ask(AFTER - 100000)]), 'waiting', 'a CI result alone is not an answer');
  for (const m of [va.MARK.ciResult, va.MARK.auto]) assert.match(m, /VQ[KM]$/);
});

test('shadow report: joins CI rows with the owner outcome and applies the arming rule', () => {
  const issues = [];
  for (let i = 0; i < 25; i++) {
    const t = Date.parse('2026-11-14T00:00:00Z') + i * 6 * 3600000;
    const id = `BRO-${100 + i}`;
    const body = va.buildBlock({ what: 'w', patch: String(i).padStart(40, '1'), verdict: VERDICT, hold: `visual-hold/bro-${100 + i}`, evidence: [{ label: 'R', url: `https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${'c'.repeat(40)}/h.png` }], summary: 's' });
    const patch = String(i).padStart(40, '1');
    const mk = (b, at) => ({ id: 'x', body: b, createdAt: new Date(at).toISOString() });
    issues.push({
      identifier: id, description: body,
      comments: { nodes: [mk('Asked the owner to look at w.', t), mk(vci.buildCiComment({ secret: S, id, patch, outcome: 'identical', base: BASE, digest: 'e'.repeat(16), reasons: [], armed: false }), t + 600000), mk(link.visualMarker(link.visualMac(S, id, patch, VERDICT)), t + 900000)] },
    });
  }
  const { rows, missing } = shadow.buildRows(issues, S, { now: Date.parse('2026-11-25T00:00:00Z') });
  assert.equal(rows.length, 25); assert.equal(missing, 0);
  const a = vci.assessVisualShadow(rows, { now: Date.parse('2026-11-25T00:00:00Z'), missing });
  assert.equal(a.ready, true, a.problems.join(';'));
  assert.equal(vci.assessVisualShadow(rows, { now: Date.parse('2026-11-18T00:00:00Z'), missing }).ready, false, 'not before the date');
  assert.equal(vci.assessVisualShadow(rows.slice(0, 10), { now: Date.parse('2026-11-25T00:00:00Z') }).ready, false, 'too few rows');
  const rejected = rows.map((r, i) => (i === 0 ? { ...r, owner: 'rejected' } : r));
  assert.equal(vci.assessVisualShadow(rejected, { now: Date.parse('2026-11-25T00:00:00Z') }).ready, false, 'an owner reject on an identical row blocks arming');
  assert.equal(shadow.buildRows(issues, 'wrong', { now: Date.parse('2026-11-25T00:00:00Z') }).rows.length, 0, 'unverifiable results count for nothing');
});

test('WIDTHS in the trusted recorder equal the capture driver widths', () => {
  const src = fs.readFileSync(path.join(here, 'visual-capture.mjs'), 'utf8');
  const m = /WIDTHS\s*=\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, 'visual-capture.mjs exports WIDTHS');
  assert.deepEqual(m[1].split(',').map((x) => Number(x.trim())), require('../visual-ci.js').WIDTHS);
});

test('trust split: the capture workflow holds no secret, the recorder runs on main', () => {
  const root = path.join(here, '..', '..', '.github', 'workflows');
  const cap = fs.readFileSync(path.join(root, 'visual-identical-ci.yml'), 'utf8');
  assert.doesNotMatch(cap, /APPROVAL_HMAC_SECRET|LINEAR_API_KEY/);
  assert.match(cap, /permissions:\s*\n\s*contents: read/);
  const rec = fs.readFileSync(path.join(root, 'visual-identical-record.yml'), 'utf8');
  assert.match(rec, /workflow_run:/);
  assert.match(rec, /ref: main/);
  assert.match(rec, /startsWith\(github\.event\.workflow_run\.head_branch, 'visual-hold\/'\)/);
});

// End to end through the real driver (capture only) and the real trusted compare. Skips only when there is no browser.
test('capture-only driver + trusted compare: same pages identical, a recolour different, a missing element incomplete', async (t) => {
  const serve = (color, body = '<div data-testid="x" style="width:200px;height:100px;background:' + color + '">hi</div>') => new Promise((res) => {
    const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><html><body style="margin:0">' + body + '</body></html>'); });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
  const [base, same, other] = await Promise.all([serve('#c33'), serve('#c33'), serve('#33c')]);
  const port = (s) => s.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vci-'));
  try {
    const rec = require('../visual-ci.js');
    const run = async (name, headSrv, elements) => {
      const plan = { routes: ['/page'], states: {}, ready: {}, elements };
      const pf = path.join(tmp, name + '.json'); fs.writeFileSync(pf, JSON.stringify(plan));
      const dir = path.join(tmp, name);
      // Async spawn: the servers live in this process, so a blocking spawnSync would starve them and hang the driver.
      const r = await new Promise((res) => {
        const c = spawn(process.execPath, [path.join(here, '..', 'visual-identical.mjs'), `--base-url=http://127.0.0.1:${port(base)}`, `--head-url=http://127.0.0.1:${port(headSrv)}`, `--plan=${pf}`, '--capture-only', `--shots-dir=${dir}`, `--out=${path.join(tmp, 'out-' + name)}`]);
        let stdout = ''; let stderr = '';
        c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => c.kill('SIGKILL'), 120000);
        c.on('close', (status) => { clearTimeout(timer); res({ status, stdout, stderr }); });
      });
      if (r.status !== 0) { assert.match(String(r.stderr) + String(r.stdout), /launch|Executable doesn't exist|playwright/i, 'driver crashed: ' + r.stderr); return null; }
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (manifest.canary !== true) return null; // no usable browser here (same skip rule as the older end-to-end test)
      const { pairs, elementsFound } = await rec.comparePairs(dir, plan, manifest);
      const canaryOk = manifest.canary === true && (await require('./visual-identical.js').compareImages(path.join(dir, 'canary.a.png'), path.join(dir, 'canary.b.png'), vci.STRICT)).same === false;
      return vci.evaluate({ plan, pairs, canaryOk, elementsFound, widths: WIDTHS });
    };
    const a = await run('same', same, ['[data-testid="x"]']);
    if (a === null) { t.skip('no browser here'); return; }
    assert.equal(a.outcome, 'identical', `reasons: ${JSON.stringify(a.reasons)}`);
    assert.equal((await run('recolour', other, ['[data-testid="x"]'])).outcome, 'different');
    assert.equal((await run('noel', same, ['[data-testid="nope"]'])).outcome, 'incomplete');
  } finally { for (const s of [base, same, other]) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
