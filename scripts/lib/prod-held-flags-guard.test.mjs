// Tests for prod-held-flags-guard.js: the pre-build check that keeps
// owner-held features (BRO-4525: commercial) out of production deploys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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

test('NEXT_PUBLIC_FEATURES is read from a pulled env file, quoted or not', () => {
  assert.equal(featuresFromEnvFile('VERCEL="1"\nNEXT_PUBLIC_FEATURES="westEnd,commercial"\n'), 'westEnd,commercial');
  assert.equal(featuresFromEnvFile("NEXT_PUBLIC_FEATURES='commercial'"), 'commercial');
  assert.equal(featuresFromEnvFile('NEXT_PUBLIC_FEATURES=westEnd'), 'westEnd');
  assert.equal(featuresFromEnvFile('OTHER=1\n'), '');
  assert.equal(featuresFromEnvFile('export NEXT_PUBLIC_FEATURES="commercial"'), 'commercial');
  assert.equal(featuresFromEnvFile('NEXT_PUBLIC_FEATURES=westEnd,commercial # held'), 'westEnd,commercial');
  assert.equal(featuresFromEnvFile('NEXT_PUBLIC_FEATURES="westEnd" # note'), 'westEnd');
  assert.equal(featuresFromEnvFile('NEXT_PUBLIC_FEATURES="westEnd"\r\nNEXT_PUBLIC_FEATURES="commercial"\r\n'), 'commercial');
});

test('held features are matched as whole items only', () => {
  assert.deepEqual(heldFeaturesEnabled('westEnd, commercial ', ['commercial']), ['commercial']);
  assert.deepEqual(heldFeaturesEnabled('commercialX,biz', ['commercial']), []);
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
