// BRO-7491 Phase 1: the before/after comparison is advisory and fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const vi = require('./visual-identical.js');
const sharp = require('sharp');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-test-'));

async function png(name, { w = 40, h = 40, block = null, noise = 0 } = {}) {
  const buf = Buffer.alloc(w * h * 3, 255);
  if (block) for (let y = block.y; y < block.y + block.s; y++) for (let x = block.x; x < block.x + block.s; x++) { const i = (y * w + x) * 3; buf[i] = 10; buf[i + 1] = 10; buf[i + 2] = 10; }
  for (let k = 0; k < noise; k++) buf[k * 3] = 253; // within the channel tolerance
  const p = path.join(tmp, name);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(p);
  return p;
}

test('identical images are the same; sub-tolerance noise is the same', async () => {
  const a = await png('a.png'); const b = await png('b.png'); const n = await png('n.png', { noise: 300 });
  assert.equal((await vi.compareImages(a, b)).same, true);
  assert.equal((await vi.compareImages(a, n)).same, true);
});

test('a moved block, a size change, a missing file and a corrupt file are all "different" (fail closed)', async () => {
  const a = await png('a2.png'); const blk = await png('blk.png', { block: { x: 5, y: 5, s: 8 } }); const big = await png('big.png', { w: 40, h: 41 });
  fs.writeFileSync(path.join(tmp, 'bad.png'), 'not an image');
  assert.equal((await vi.compareImages(a, blk)).same, false);
  assert.match((await vi.compareImages(a, big)).reason, /size differs/);
  assert.equal((await vi.compareImages(a, path.join(tmp, 'nope.png'))).same, false);
  assert.equal((await vi.compareImages(a, path.join(tmp, 'bad.png'))).same, false);
});

test('absolute cap: a thin change on a tall image is not hidden by a ratio', async () => {
  const w = 400; const h = 5000;
  const a = Buffer.alloc(w * h * 3, 255); const b = Buffer.from(a);
  for (let y = 0; y < h; y += 100) for (let x = 0; x < w; x++) { b[(y * w + x) * 3] = 0; }
  const pa = path.join(tmp, 'tall-a.png'); const pb = path.join(tmp, 'tall-b.png');
  await sharp(a, { raw: { width: w, height: h, channels: 3 } }).png().toFile(pa);
  await sharp(b, { raw: { width: w, height: h, channels: 3 } }).png().toFile(pb);
  assert.equal((await vi.compareImages(pa, pb)).same, false);
});

test('decide: only "every pair same and the self-test passed" is identical', () => {
  const same = (n) => Array.from({ length: n }, () => ({ route: '/', width: 360, state: '', status: 'same' }));
  assert.equal(vi.decide(same(3), true).identical, true);
  assert.equal(vi.decide([], true).identical, false);
  assert.equal(vi.decide(null, true).identical, false);
  assert.equal(vi.decide(same(3), false).outcome, 'invalid');
  assert.equal(vi.decide(same(3), undefined).identical, false);
  assert.equal(vi.decide([...same(2), { route: '/', width: 768, state: 'open', status: 'error', reason: 'x' }], true).outcome, 'could-not-render');
  assert.equal(vi.decide([...same(2), { route: '/', width: 768, state: '', status: 'different' }], true).outcome, 'different');
});

test('class guard: a shadow decision never skips the owner, whatever the report says', () => {
  const allSame = { schema: 1, canaryOk: true, patch: 'p1', pairs: [{ route: '/', width: 360, state: '', status: 'same' }] };
  for (const report of [allSame, null, undefined, {}, { canaryOk: true, pairs: [] }, { ...allSame, patch: 'other' }, { ...allSame, patch: '' }, { ...allSame, schema: 2 }, 'x', 5]) {
    const d = vi.shadowDecision(report, 'p1');
    assert.equal(d.skipAsk, false);
    assert.ok(d.line.startsWith(vi.SHADOW_MARK));
  }
  assert.match(vi.shadowDecision(allSame, 'p1').line, /matched/);
  assert.match(vi.shadowDecision(allSame, 'different-patch').line, /not run on this version/);
  assert.doesNotMatch(vi.shadowDecision(allSame, 'p1').line, /identical=|true|false|[;:]\s*\{/);
});

test('request wiring: the shadow record sits after the ask and cannot stop it', () => {
  const src = fs.readFileSync(new URL('../visual-approval.js', import.meta.url), 'utf8');
  const ask = src.indexOf("createComment(issue.id, `Asked the owner to look at");
  const shadow = src.lastIndexOf('shadowDecision(');
  assert.ok(ask > 0 && shadow > ask, 'shadow record must come after the ask comment');
  assert.match(src.slice(shadow - 700, shadow + 600), /try\s*\{[\s\S]*catch/);
  assert.doesNotMatch(src.split('\n').filter((l) => /^const .*require\(/.test(l)).join('\n'), /visual-identical/, 'must be loaded inside the guarded block, not at module level');
  assert.doesNotMatch(src, /skipAsk\s*\)\s*return|if\s*\(\s*[a-z.]*skipAsk/);
});

// End to end with two tiny static pages. Skipped when no Chromium can launch (the driver is the same code path).
function serve(html) {
  return new Promise((resolve) => { const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const page = (color, extra = '') => `<!doctype html><html><body style="margin:0;font:16px sans-serif"><div id="box" style="height:120px;background:${color}">hello</div><button id="b" onclick="document.getElementById('p').style.display='block'">open</button><div id="p" style="display:none;height:60px;background:${extra || '#ccc'}">panel</div></body></html>`;

async function drive(baseHtml, headHtml, withState) {
  const [sb, sh] = [await serve(baseHtml), await serve(headHtml)];
  const out = fs.mkdtempSync(path.join(tmp, 'out-'));
  const states = path.join(out, 'states.json');
  fs.writeFileSync(states, JSON.stringify({ '/': withState ? [{ name: 'panel open', click: '#b', waitFor: '#p' }] : [] }));
  try {
    // Async spawn: the test process also serves the two pages, so it must not block while the driver runs.
    const r = await new Promise((resolve) => {
      const c = spawn('node', ['scripts/visual-identical.mjs', `--base-url=http://127.0.0.1:${sb.address().port}`, `--head-url=http://127.0.0.1:${sh.address().port}`, '--paths=/', `--states=${states}`, `--out=${out}`], { env: { ...process.env, VISUAL_IDENTICAL_SETTLE_MS: '50' } });
      let stderr = ''; c.stderr.on('data', (d) => { stderr += d; }); c.stdout.resume();
      const timer = setTimeout(() => c.kill(), 170000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    });
    const f = path.join(out, 'identical.json');
    return { status: r.status, stderr: r.stderr, report: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null };
  } finally { sb.close(); sh.close(); }
}

test('end to end: identical pages (including an opened panel) are identical; a panel colour change is caught', { timeout: 400000 }, async (t) => {
  const same = await drive(page('#fff'), page('#fff'), true);
  if (!same.report) { t.skip(`driver could not run here: ${String(same.stderr).slice(0, 120)}`); return; }
  if (['could-not-render', 'invalid'].includes(same.report.outcome)) { t.skip(`no browser here: ${same.report.reasons[0]}`); return; }
  assert.equal(same.report.outcome, 'identical');
  assert.equal(same.report.canaryOk, true);
  assert.ok(same.report.pairs.some((p) => p.state === 'panel open'), 'the opened-panel state was compared');
  const diff = await drive(page('#fff'), page('#fff', '#cde'), true);
  assert.equal(diff.report.outcome, 'different');
  assert.ok(diff.report.pairs.some((p) => p.state === 'panel open' && p.status === 'different'));
});

test('the driver refuses the same server (even under another hostname) and a page-wide mask', () => {
  const same = spawnSync('node', ['scripts/visual-identical.mjs', '--base-url=http://localhost:3000', '--head-url=http://127.0.0.1:3000'], { encoding: 'utf8' });
  assert.equal(same.status, 2);
  const m = spawnSync('node', ['scripts/visual-identical.mjs', '--base-url=http://x:1', '--head-url=http://y:2', '--mask=body'], { encoding: 'utf8' });
  assert.equal(m.status, 2);
  const r = spawnSync('node', ['scripts/visual-identical.mjs', '--base-url=http://x:1', '--head-url=http://x:1'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('a states file that cannot be read, or a state with no click, makes the run "could not render", never identical', async (t) => {
  const sb = await serve(page('#fff')); const out = fs.mkdtempSync(path.join(tmp, 'bad-'));
  const run = (statesPath) => new Promise((resolve) => {
    const c = spawn('node', ['scripts/visual-identical.mjs', `--base-url=http://127.0.0.1:${sb.address().port}`, '--head-url=http://127.0.0.1:9', '--paths=/', `--states=${statesPath}`, `--out=${out}`], { env: { ...process.env, VISUAL_IDENTICAL_SETTLE_MS: '50' } });
    c.stdout.resume(); c.stderr.resume(); c.on('close', () => resolve(JSON.parse(fs.readFileSync(path.join(out, 'identical.json'), 'utf8'))));
  });
  try {
    const r1 = await run(path.join(out, 'missing.json'));
    assert.equal(r1.identical, false);
    const bad = path.join(out, 'noclick.json'); fs.writeFileSync(bad, JSON.stringify({ '/': [{ name: 'open' }] }));
    const r2 = await run(bad);
    assert.equal(r2.identical, false);
    assert.match(JSON.stringify(r2.pairs), /no name or no click/);
    assert.equal(fs.readdirSync(out).filter((f) => f.includes('work')).length, 0, 'no scratch folder is left under the evidence dir');
  } finally { sb.close(); }
});
