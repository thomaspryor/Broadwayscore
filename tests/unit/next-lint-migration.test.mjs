// BRO-5215: Next 16 removes `next lint`. Lint runs through the ESLint CLI with a
// flat config; nothing that executes lint may call `next lint` again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('package.json lint script runs the ESLint CLI, not next lint', () => {
  const { scripts } = JSON.parse(read('package.json'));
  assert.match(scripts.lint, /^eslint\b/);
  assert.doesNotMatch(scripts.lint, /next lint/);
});

test('flat config exists and the legacy .eslintrc.json is gone', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'eslint.config.mjs')));
  assert.ok(!fs.existsSync(path.join(ROOT, '.eslintrc.json')));
  assert.match(read('eslint.config.mjs'), /next\/core-web-vitals/);
});

test('files that execute lint do not call `next lint`', () => {
  for (const f of ['.github/workflows/test.yml', 'scripts/lib/land-gauntlet.sh', 'scripts/lib/autonomous-checks.js']) {
    const bad = read(f).split('\n').filter((l) => /(npx next lint|run: next lint|'next', 'lint')/.test(l) && !/^\s*(#|\/\/|\*)/.test(l) && !/name:\s*next lint/.test(l));
    assert.deepEqual(bad, [], `${f} still executes next lint`);
  }
  assert.match(read('.github/workflows/test.yml'), /run: npm run lint\b/);
});

test('ESLint CLI still fails on a rules-of-hooks error (rule set intact)', { skip: !fs.existsSync(path.join(ROOT, 'node_modules/.bin/eslint')) }, () => {
  // Keep the probe off disk so parallel src/ scans cannot race its cleanup.
  assert.throws(() => execFileSync('npx', ['eslint', '--stdin', '--stdin-filename', 'src/lint-probe.tsx'], {
    cwd: ROOT,
    stdio: 'pipe',
    input: 'export const A = () => <div />;\nif (true) { useEffect(() => {}); }\n',
  }), (e) => e.status === 1 && /rules-of-hooks/.test(String(e.stdout)));
});
