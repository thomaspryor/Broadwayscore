// Tests for prod-held-flags-guard.js: the pre-build check that keeps
// owner-held features (BRO-4525: commercial) out of production deploys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHeldFeatures, featuresFromEnvFile, heldFeaturesEnabled, main } = require('./prod-held-flags-guard.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('feature-flags.ts holds commercial back from production', () => {
  assert.ok(parseHeldFeatures(read('src/config/feature-flags.ts')).includes('commercial'));
});

test('an empty held list parses (releasing the last held feature must not break deploys)', () => {
  assert.deepEqual(parseHeldFeatures('export const PROD_HELD_FEATURES = new Set([]);'), []);
  assert.deepEqual(parseHeldFeatures('export const PROD_HELD_FEATURES = new Set([\n]);'), []);
});

test('a missing or renamed declaration throws instead of passing', () => {
  assert.throws(() => parseHeldFeatures('const DEMO_FEATURES = new Set([\'showtimes\']);'), /not found/);
});

test('typed and double-quoted declarations parse', () => {
  const src = 'export const PROD_HELD_FEATURES: ReadonlySet<string> = new Set<string>(["a", \'b\']);';
  assert.deepEqual(parseHeldFeatures(src), ['a', 'b']);
});

test('held names the tokenizer could never match are rejected', () => {
  assert.throws(() => parseHeldFeatures("export const PROD_HELD_FEATURES = new Set(['biz-v2']);"), /cannot match/);
});

const heldIn = (envText) => heldFeaturesEnabled(featuresFromEnvFile(envText), ['commercial']);

// [env file text, whether Next.js's own parser turns commercial on]. The second
// value is checked against @next/env below, so a wrong expectation fails too.
const ENV_FIXTURES = [
  ['VERCEL="1"\nNEXT_PUBLIC_FEATURES="westEnd,commercial"\n', true],
  ["NEXT_PUBLIC_FEATURES='commercial'", true],
  ['NEXT_PUBLIC_FEATURES=westEnd', false],
  ['OTHER=1\n', false],
  ['export NEXT_PUBLIC_FEATURES="commercial"', true],
  ['NEXT_PUBLIC_FEATURES=westEnd,commercial # held', true],
  ['NEXT_PUBLIC_FEATURES="westEnd" # note', false],
  ['NEXT_PUBLIC_FEATURES="westEnd"\r\nNEXT_PUBLIC_FEATURES="commercial"\r\n', true],
  ['NEXT_PUBLIC_FEATURES="commercial"\nNEXT_PUBLIC_FEATURES="westEnd"\n', false],
  ['NEXT_PUBLIC_FEATURES="a\\"b,commercial"', true],
  ['NEXT_PUBLIC_FEATURES="x" ,commercial', true],
  ['NEXT_PUBLIC_FEATURES="westEnd,\ncommercial"\nVERCEL="1"\n', true],
  ['NEXT_PUBLIC_FEATURES="westEnd"\nZ_NOTE="commercial"\n', false],
];

test('a held feature in the pulled env file is found however the line is formatted', () => {
  assert.equal(featuresFromEnvFile('OTHER=1\n'), '');
  for (const [text, on] of ENV_FIXTURES) {
    assert.deepEqual(heldIn(text), on ? ['commercial'] : [], JSON.stringify(text));
  }
});

test('the guard never misses what Next.js itself would enable (checked with @next/env)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'held-flags-next-'));
  const dirs = ENV_FIXTURES.map(([text], i) => {
    const d = path.join(dir, String(i));
    mkdirSync(d);
    writeFileSync(path.join(d, '.env.production.local'), text);
    return d;
  });
  // A child process, because loadEnvConfig rewrites process.env.
  const script = `const { loadEnvConfig } = require('@next/env');
    const out = JSON.parse(process.argv[1]).map(d => {
      const v = loadEnvConfig(d, false, { info() {}, error() {} }, true).combinedEnv.NEXT_PUBLIC_FEATURES || '';
      return v.split(',').map(s => s.trim()).includes('commercial');
    });
    console.log(JSON.stringify(out));`;
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_FEATURES;
  const nextSees = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(dirs)], { cwd: ROOT, env, encoding: 'utf8' }));
  ENV_FIXTURES.forEach(([text, on], i) => {
    assert.equal(nextSees[i], on, `fixture expectation vs @next/env: ${JSON.stringify(text)}`);
    if (nextSees[i]) assert.deepEqual(heldIn(text), ['commercial'], `guard missed: ${JSON.stringify(text)}`);
  });
});

test('held features are matched as whole names only', () => {
  assert.deepEqual(heldFeaturesEnabled('westEnd, commercial ', ['commercial']), ['commercial']);
  assert.deepEqual(heldFeaturesEnabled('commercialX,biz', ['commercial']), []);
  assert.deepEqual(heldFeaturesEnabled('commercial_x', ['commercial']), []);
  assert.deepEqual(heldFeaturesEnabled(undefined, ['commercial']), []);
});

test('main(): fails on a held flag in the env file or the shell, passes otherwise, fails without the file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'held-flags-'));
  const withHeld = path.join(dir, 'held.env');
  const clean = path.join(dir, 'clean.env');
  writeFileSync(withHeld, 'NEXT_PUBLIC_FEATURES="westEnd,commercial"\n');
  writeFileSync(clean, 'NEXT_PUBLIC_FEATURES="westEnd,tonyPredictions"\n');
  const quiet = { error: console.error, log: console.log };
  console.error = console.log = () => {};
  try {
    assert.equal(main([withHeld], {}), 1);
    assert.equal(main([clean], {}), 0);
    assert.equal(main([clean], { NEXT_PUBLIC_FEATURES: 'commercial' }), 1);
    assert.equal(main([path.join(dir, 'missing.env')], {}), 1);
    assert.equal(main([clean], { NEXT_PUBLIC_FEATURES: '${HELD}' }), 1);
  } finally {
    Object.assign(console, quiet);
  }
});

// Line number of the first non-comment line containing `needle` (-1 if none),
// so a comment that mentions a command can't satisfy or break the ordering check.
function codeLine(text, needle) {
  return text.split('\n').findIndex(l => !/^\s*(#|\/\/|\*|\/\*)/.test(l) && l.includes(needle));
}

test('both prod deploy paths run the guard before vercel build --prod', () => {
  const wf = read('.github/workflows/vercel-deploy.yml');
  const wfGuard = codeLine(wf, 'node scripts/lib/prod-held-flags-guard.js');
  assert.ok(wfGuard > 0, 'vercel-deploy.yml must run prod-held-flags-guard.js');
  assert.ok(wfGuard > codeLine(wf, 'npx vercel pull --yes --environment=production'), 'guard runs after vercel pull');
  assert.ok(wfGuard < codeLine(wf, 'npx vercel build --prod'), 'guard runs before vercel build --prod');

  const dn = read('scripts/deploy-now.js');
  const dnGuard = codeLine(dn, 'checkHeldFeatures([], env)');
  assert.ok(dnGuard > 0, 'deploy-now.js must call the guard');
  assert.ok(dnGuard > codeLine(dn, 'vercel pull --yes --environment=production'), 'deploy-now: guard after vercel pull');
  assert.ok(dnGuard < codeLine(dn, 'vercel build --prod'), 'deploy-now: guard before vercel build --prod');
});
