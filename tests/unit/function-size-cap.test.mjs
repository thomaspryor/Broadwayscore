// BRO-8155: the deploy Build step must cap @vercel/next's function grouping below the 250MiB limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('vercel-deploy Build step caps function size at <= 175MiB (packs groups to <= 150MiB)', () => {
  const y = readFileSync(join(ROOT, '.github/workflows/vercel-deploy.yml'), 'utf8');
  const m = y.match(/MAX_UNCOMPRESSED_LAMBDA_SIZE:\s*'?(\d+)'?/);
  assert.ok(m, 'Build step must set MAX_UNCOMPRESSED_LAMBDA_SIZE');
  assert.ok(Number(m[1]) <= 175 * 1024 * 1024, `cap ${m[1]} exceeds 175MiB`);
  assert.ok(y.indexOf(m[0]) > y.indexOf('- name: Build\n'), 'cap must sit in the Build step env');
});

test('playwright and musl sharp stay out of function traces', () => {
  const c = readFileSync(join(ROOT, 'next.config.js'), 'utf8');
  for (const g of ['node_modules/playwright/**', 'node_modules/playwright-core/**', 'node_modules/@img/sharp-libvips-linuxmusl-*/**']) {
    assert.ok(c.includes(g), `next.config.js must exclude ${g}`);
  }
});

// BRO-8172: every workflow/script that actually runs `vercel build` must carry the cap.
test('every workflow step and script that runs `vercel build` sets MAX_UNCOMPRESSED_LAMBDA_SIZE <= 175MiB', async () => {
  const { readdirSync } = await import('node:fs');
  const wfDir = join(ROOT, '.github/workflows');
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(wfDir, f));
  files.push(join(ROOT, 'scripts/deploy-now.js'));
  const runners = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    // executed invocation only: not comments, not echo/error strings
    const runs = t.split('\n').some((l) => /^\s*(timeout \d+ )?(npx( --yes)? )?vercel build\b/.test(l) || /execSync\(`npx --yes vercel build/.test(l));
    if (!runs) continue;
    runners.push(f);
    const m = t.match(/MAX_UNCOMPRESSED_LAMBDA_SIZE:\s*'?(\d+)'?/);
    assert.ok(m, `${f} runs vercel build without MAX_UNCOMPRESSED_LAMBDA_SIZE`);
    assert.ok(Number(m[1]) <= 175 * 1024 * 1024, `${f} cap ${m[1]} exceeds 175MiB`);
  }
  assert.ok(runners.length >= 4, `expected >=4 vercel-build runners, found ${runners.length}: ${runners.join(', ')}`);
});
