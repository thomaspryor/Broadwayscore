import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evaluate, render } from './land-ready.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = { doctor: { ok: true }, dirty: [], uiFiles: [], gatedFiles: [], renderImpactDropped: [], uiCommitsMissingPrefix: [], touchesSrc: false, transcript: { found: true }, coverage: { ran: true, complete: true, missing: [] }, judge: { decision: 'allow' } };

test('a clean branch with no UI files needs no owner approval and every box is ticked', () => {
  const r = evaluate(base);
  assert.equal(r.missing.length, 0);
  assert.equal(r.owner.line, 'No owner approval needed');
  assert.match(render(r), /No owner approval needed$/);
});

test('missing build + ship-check + verdict are ALL reported in one run, owner is told not to be asked yet', () => {
  const r = evaluate({ ...base, uiFiles: ['src/a.tsx'], gatedFiles: ['src/a.tsx'], touchesSrc: true, verdict: { exists: false },
    coverage: { ran: true, complete: false, missing: ['the build (`npm run build`, Phase 2)', 'Claude codebase review (an Agent call)'] } });
  const ids = r.missing.map((i) => i.id);
  assert.deepEqual(ids.sort(), ['build', 'shipcheck', 'verdict']);
  assert.equal(r.owner.line, 'Ask the owner now: no');
  const text = render(r);
  assert.match(text, /npm run build/); assert.match(text, /visual verdict/); assert.match(text, /ship-check/);
  assert.match(text, /Ask the owner now: no$/);
});

test('everything done on a rendering UI diff: ask the owner now, once; already approved: no approval needed', () => {
  const ready = { ...base, uiFiles: ['src/a.tsx'], gatedFiles: ['src/a.tsx'], verdict: { exists: true, schemaOk: true, overallPass: true, uiPatchId: 'abc', currentPatchId: 'abc' } };
  assert.equal(evaluate(ready).owner.line, 'Ask the owner now: yes');
  assert.equal(evaluate({ ...ready, approval: { approved: true } }).owner.line, 'No owner approval needed');
});

test('a verdict for an older diff (uiPatchId mismatch) is an open item', () => {
  const r = evaluate({ ...base, uiFiles: ['src/a.tsx'], gatedFiles: ['src/a.tsx'], verdict: { exists: true, schemaOk: true, overallPass: true, uiPatchId: 'old', currentPatchId: 'new' } });
  assert.ok(r.missing.some((i) => i.id === 'verdict' && /older/.test(i.detail)));
});

test('non-rendering and text-only UI diffs need no owner approval', () => {
  assert.equal(evaluate({ ...base, uiFiles: ['src/a.tsx'], renderImpactDropped: ['src/a.tsx'] }).owner.line, 'No owner approval needed');
  assert.match(evaluate({ ...base, uiFiles: ['src/a.tsx'], renderImpactDropped: ['src/a.tsx'] }).cls, /non-rendering/);
});

test('dirty tree, unprefixed UI commit and a blocked land dry run are all listed together', () => {
  const r = evaluate({ ...base, dirty: ['x.js'], uiFiles: ['src/a.tsx'], uiCommitsMissingPrefix: ['abc1234'], judge: { decision: 'block', message: 'rebase conflict in x\nmore' } });
  assert.deepEqual(r.missing.map((i) => i.id).sort(), ['judge', 'prefix', 'tree']);
});

test('CLI on a real branch with a UI change and no transcript lists every open item and ends on the owner line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(dir, 'src/components'), { recursive: true });
  writeFileSync(join(dir, 'src/components/A.tsx'), 'export default function A(){return <p>a</p>}\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'src/components/A.tsx'), 'export default function A(){return <p className="b">a</p>}\n');
  g('add', '-A'); g('commit', '-qm', 'tweak');
  const out = execFileSync('node', [join(HERE, 'land-ready.mjs'), '--no-doctor', '--no-judge'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', LAND_READY_CWD: dir, HOME: dir },
  });
  assert.match(out, /\[ \] `npm run build`/);
  assert.match(out, /\[ \] visual verdict/);
  assert.match(out, /\[ \] \/ship-check/);
  assert.match(out, /\[ \] UI commits carry VISUAL-OK-1440/);
  assert.match(out.trim().split('\n').pop(), /^Ask the owner now: no$/);
});

test('a verdict whose overallPass is not true never counts as ready (BRO-7849 ship-check)', () => {
  const ready = { ...base, uiFiles: ['src/a.tsx'], gatedFiles: ['src/a.tsx'], touchesSrc: true, verdict: { exists: true, schemaOk: true, overallPass: false, uiPatchId: 'p', currentPatchId: 'p' } };
  assert.equal(evaluate(ready).missing.some((m) => m.id === 'verdict'), true);
  assert.equal(evaluate({ ...ready, verdict: { ...ready.verdict, overallPass: true } }).missing.some((m) => m.id === 'verdict'), false);
});

test('an unreadable diff never reads as "No owner approval needed" (BRO-7849 final review)', () => {
  const r = evaluate({ diffError: true, uiFiles: [], gatedFiles: [], doctor: { skipped: true }, dirty: [] });
  assert.equal(r.owner.line, 'Ask the owner now: no');
  assert.ok(r.missing.some((m) => m.id === 'diff'));
});
