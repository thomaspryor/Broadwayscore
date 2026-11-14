// Test helper: run a shows.json-writing script against a temp fixture file.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function runInSandbox(scriptName, args, shows) {
  const dir = mkdtempSync(join(tmpdir(), 'shows-sandbox-'));
  const file = join(dir, 'shows.json');
  writeFileSync(file, JSON.stringify({ _meta: { totalShows: shows.length }, shows }, null, 2) + '\n');
  try {
    const r = spawnSync(process.execPath, ['-r', join(here, 'shows-sandbox-preload.cjs'), join(here, '..', scriptName), ...args], {
      env: { ...process.env, SHOWS_SANDBOX_FILE: file },
      encoding: 'utf8',
      timeout: 30000,
    });
    // A timeout or spawn failure must say so, not surface as `status: null`.
    if (r.error || r.signal) throw new Error(`sandbox run of ${scriptName} did not finish (${r.error ? r.error.code || r.error.message : `signal ${r.signal}`}); stderr: ${r.stderr}`);
    let after;
    try { after = JSON.parse(readFileSync(file, 'utf8')).shows; } catch (e) { throw new Error(`sandbox shows.json unreadable (${e.message}); stderr: ${r.stderr}`); }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
