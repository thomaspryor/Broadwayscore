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

function installScript() {
  const raw = fs.readFileSync(ACTION, 'utf8');
  const block = extractRunBlocks(raw).find((b) => b.lines.some((l) => l.text.includes('playwright install')));
  assert.ok(block, 'Install Playwright browsers run: block not found');
  const indent = Math.min(...block.lines.filter((l) => l.text.trim()).map((l) => l.text.length - l.text.trimStart().length));
  return block.lines
    .map((l) => l.text.slice(indent))
    .join('\n')
    .replace(/\$\{\{\s*steps\.playwright-cache\.outputs\.cache-hit\s*\}\}/g, 'false')
    .replace(/\$\{\{\s*inputs\.browsers\s*\}\}/g, 'chromium');
}

// npx stub: exit code per call taken from $NPX_CODES (space-separated).
function runWith(codes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-retry-'));
  const counter = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'npx'), `#!/bin/bash
n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${counter}"
code=$(echo "$NPX_CODES" | cut -d' ' -f"$n")
echo "npx attempt $n output"
exit "\${code:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, installScript());
  const r = spawnSync('bash', ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NPX_CODES: codes },
  });
  const calls = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
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
