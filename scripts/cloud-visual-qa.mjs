#!/usr/bin/env node
// scripts/cloud-visual-qa.mjs: one command for visual QA in a cloud session (BRO-7628).
//   npm run cloud:visual-qa -- --paths=/my-shows,/show/hamilton [--elements=...] [--refs=none] [-- more visual-qa.mjs flags]
// Starts `next dev` on a free port with the env Next 16 needs here (telemetry off, bigger heap), waits until the
// first route compiles, runs scripts/visual-qa.mjs (screenshots at its fixed widths, 360 to 1440, covering the 390 and
// 1440 checks) against it, then stops the server and clears .next/dev (a stale one breaks tsc, BRO-7431).
// `next start` is not used: a cloud container restart loses .next, and a dev server needs no build.
// Exit: visual-qa.mjs's exit code (2 = server unreachable / LLM FAIL), 3 = dev server never became ready.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { isMainModule } from './lib/is-main-module.mjs';
import { devServerReachable } from './lib/dev-server-reachable.mjs';

const { exitFlushed } = createRequire(import.meta.url)('./lib/exit-flushed.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const READY_TIMEOUT_MS = Number(process.env.CLOUD_VQA_READY_MS || 240000);

export function qaEnv(env = process.env) {
  const node = env.NODE_OPTIONS || '';
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: /max-old-space-size/.test(node) ? node : `${node} --max-old-space-size=6144`.trim() };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Ready = "/" passes the SAME check visual-qa.mjs runs (HTTP 200, >1KB HTML; BRO-7849: it used to probe only the first
 * --paths page with any status under 500, then visual-qa fetched "/" with a 5s timeout and failed on a cold compile).
 * Once "/" is up, each requested page is fetched once to warm its compile.
 */
export async function waitReady(base, paths, child, { totalMs = READY_TIMEOUT_MS, reachable = devServerReachable, fetchImpl = fetch } = {}) {
  const r = await reachable(`${base}/`, { totalMs, shouldAbort: () => child.exitCode !== null });
  if (!r.ok) return false;
  for (const p of paths) {
    try { await fetchImpl(base + p, { signal: AbortSignal.timeout(120000) }); } catch { /* warming only; visual-qa reports real failures */ }
  }
  return true;
}

/** Every page named by --paths (default "/"). */
export function allPaths(args) {
  const a = args.find((x) => x.startsWith('--paths='));
  const i = args.indexOf('--paths');
  const v = a ? a.slice(8) : (i >= 0 ? args[i + 1] : '/');
  return (v || '/').split(',').map((x) => x.trim()).filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = qaEnv();
  console.log(`[cloud-visual-qa] starting next dev on ${base}`);
  const dev = spawn('npx', ['next', 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let tail = '';
  const keep = (d) => { tail = (tail + d).slice(-2000); };
  dev.stdout.on('data', keep); dev.stderr.on('data', keep);
  const stop = () => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('SIGINT', () => { stop(); exitFlushed(130); });
  process.on('SIGTERM', () => { stop(); exitFlushed(143); });
  let code = 3; let started = false;
  try {
    const ok = await waitReady(base, allPaths(args), dev);
    if (!ok) console.error(`[cloud-visual-qa] dev server not ready within ${READY_TIMEOUT_MS / 1000}s. Last output:\n${tail}`);
    else {
      started = true;
      console.log('[cloud-visual-qa] server ready, capturing');
      code = spawnSync('node', [join(ROOT, 'scripts/visual-qa.mjs'), `--url=${base}`, ...args], { cwd: ROOT, env, stdio: 'inherit' }).status ?? 1;
    }
  } finally {
    stop();
    await new Promise((r) => setTimeout(r, 1500));
    if (started) try { rmSync(join(ROOT, '.next', 'dev'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  exitFlushed(code);
}

if (isMainModule(import.meta.url)) main();
