// TESTS-VS-DERIVED-DATA-EXEMPT: structural — executes the real run: block of
// .github/actions/setup-playwright/action.yml with stubbed npx/sudo; no data/*.json.
/**
 * BRO-4480 — setup-playwright's install step must retry a transient failure and
 * must print diagnostics when it gives up.
 *
 * Main run 36892886642 went red when `npx playwright install` hung 8 minutes.
 * The step then printed nothing useful: it ran under `bash -e` with a bare
 * `status=$?` after the failing command, so the error/log block was dead code.
 * This test runs the REAL run: block (not a copy) under `bash -e` — the shell
 * GitHub uses — with `npx` and `sudo` stubbed on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractRunBlocks } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.join(__dirname, '..', '..', '.github', 'actions', 'setup-playwright', 'action.yml');

function installScript({ cacheHit = false } = {}) {
  const raw = fs.readFileSync(ACTION, 'utf8');
  const block = extractRunBlocks(raw).find((b) => b.lines.some((l) => l.text.includes('playwright install')));
  assert.ok(block, 'Install Playwright browsers run: block not found');
  const indent = Math.min(...block.lines.filter((l) => l.text.trim()).map((l) => l.text.length - l.text.trimStart().length));
  return block.lines
    .map((l) => l.text.slice(indent))
    .join('\n')
    .replace(/\$\{\{\s*steps\.playwright-cache\.outputs\.cache-hit\s*\}\}/g, String(cacheHit));
}

// npx stub: exit code per call taken from $NPX_CODES (space-separated).
// Both stubs append to $ORDER so a test can check what ran first; sudo also
// records its stdin (the apt conf body piped into `sudo tee`).
function runWith(codes, { cacheHit = false, sudoTeeFail = false, nodeCode = null, optional = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-retry-'));
  // node stub: stands in for the chromium launch probe (BRO-5818).
  if (nodeCode !== null) fs.writeFileSync(path.join(dir, 'node'), `#!/bin/bash\necho "node probe" >> "${path.join(dir, 'order')}"\nexit ${nodeCode}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, '.cache', 'ms-playwright'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cache', 'ms-playwright', 'partial'), 'x');
  const counter = path.join(dir, 'calls');
  const order = path.join(dir, 'order');
  fs.writeFileSync(path.join(dir, 'npx'), `#!/bin/bash
n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${counter}"
code=$(echo "$NPX_CODES" | cut -d' ' -f"$n")
echo "npx $*" >> "${order}"
echo "npx attempt $n output"
exit "\${code:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sudo'), `#!/bin/bash
echo "sudo $*" >> "${order}"
[ "$1" = tee ] && cat >> "${order}"
[ "$1" = tee ] && [ -n "$SUDO_TEE_FAIL" ] && exit 1
exit 0
`, { mode: 0o755 });
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, installScript({ cacheHit }));
  const r = spawnSync('bash', ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NPX_CODES: codes, INPUT_BROWSERS: 'chromium', INPUT_OPTIONAL: optional, HOME: dir, SUDO_TEE_FAIL: sudoTeeFail ? '1' : '' },
  });
  const calls = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
  const log = fs.existsSync(order) ? fs.readFileSync(order, 'utf8') : '';
  const cacheKept = fs.existsSync(path.join(dir, '.cache', 'ms-playwright'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { cacheKept, status: r.status, out: `${r.stdout}${r.stderr}`, calls, order: log };
}

test('first attempt succeeds: one call, exit 0, no warning', () => {
  const r = runWith('0');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, 1);
  assert.doesNotMatch(r.out, /::warning::|::error::/);
});

test('transient failure: retried once, step succeeds with a warning that shows the output', () => {
  const r = runWith('1 0');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, 2);
  assert.match(r.out, /::warning::.*failed \(exit 1\) on attempt 1 — retrying/);
  assert.match(r.out, /npx attempt 1 output/);
});

test('timeout on attempt 1 is reported as a timeout and retried', () => {
  const r = runWith('124 0');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /timed out after 220s on attempt 1/);
});

test('both attempts fail: exit 1 with ::error:: and the log (the dead-code bug this fixes)', () => {
  const r = runWith('124 124');
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls, 2);
  assert.match(r.out, /::error::.*timed out after 220s on both attempts/);
  assert.match(r.out, /npx attempt 2 output/);
});

// BRO-5964: a stalled apt mirror read used apt's 120s default timeout and ate
// both 220s attempts (main run 39790224688). The short timeout must be in place
// before the first install on both the cache-miss and cache-hit paths.
for (const cacheHit of [false, true]) {
  test(`apt net timeout conf is written before the first npx call (cache-hit=${cacheHit})`, () => {
    const r = runWith('0', { cacheHit });
    assert.equal(r.status, 0, r.out);
    const teeAt = r.order.indexOf('sudo tee /etc/apt/apt.conf.d/99-bsc-net-timeouts');
    const npxAt = r.order.indexOf('npx playwright');
    assert.ok(teeAt >= 0, `conf not written:\n${r.order}`);
    assert.ok(npxAt > teeAt, `npx ran before the conf was written:\n${r.order}`);
    assert.match(r.order, /Acquire::http::Timeout "20";/);
    assert.match(r.order, cacheHit ? /npx playwright install-deps chromium/ : /npx playwright install chromium --with-deps/);
    assert.doesNotMatch(r.out, /Acquire::/, 'tee must not echo the conf into the step log');
  });
}

test('apt conf write failure warns and still installs', () => {
  const r = runWith('0', { sudoTeeFail: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, 1);
  assert.match(r.out, /::warning::could not write apt timeout conf/);
});

// BRO-5818: install-deps (cache-hit path) stalled on the apt mirror for 13
// straight Test Suite runs while Chromium itself was fine. A launchable
// browser makes the stall a warning; an unlaunchable one (or a cache miss,
// where the browser download itself failed) stays fatal.
test('cache-hit + both attempts fail + chromium launches: warning, exit 0', () => {
  const r = runWith('124 124', { cacheHit: true, nodeCode: 0 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::install-deps failed but chromium launches/);
});

test('cache-hit + both attempts fail + chromium does not launch: still exit 1', () => {
  const r = runWith('124 124', { cacheHit: true, nodeCode: 1 });
  assert.equal(r.status, 1, r.out);
});

test('cache-miss + both attempts fail: never probes, still exit 1', () => {
  const r = runWith('124 124', { cacheHit: false, nodeCode: 0 });
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.order, /node probe/);
});

// BRO-6021: gather shards died on an apt mirror stall although Playwright is
// only their last-resort fetcher. optional=true turns the final failure into a
// warning; the default stays fatal. The partial browser dir is removed so the
// post-job cache save (key shared by every caller) cannot store it.
for (const cacheHit of [false, true]) {
  test(`optional=true + both attempts fail: warning, exit 0, partial cache dropped (cache-hit=${cacheHit})`, () => {
    const r = runWith('124 124', { cacheHit, optional: 'true', nodeCode: 1 });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls, 2);
    assert.match(r.out, /::warning::Playwright unavailable, tier skipped \(BRO-6021\)/);
    assert.equal(r.cacheKept, false, 'partial browser dir must be removed so the cache save finds nothing');
  });
}

test('optional=false (default) + both attempts fail stays fatal', () => {
  const r = runWith('124 124', { optional: 'false' });
  assert.equal(r.status, 1);
  assert.equal(r.cacheKept, true, 'fail-closed path must not touch the cache dir');
  assert.equal(runWith('124 124').status, 1);
});

test('optional=true + cache-hit + chromium launches: the BRO-5818 rescue wins first', () => {
  const r = runWith('124 124', { cacheHit: true, optional: 'true', nodeCode: 0 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /chromium launches; continuing \(BRO-5818\)/);
  assert.doesNotMatch(r.out, /tier skipped/);
});
