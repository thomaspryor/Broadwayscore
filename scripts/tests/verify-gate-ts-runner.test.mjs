/**
 * verify-gate-ts-runner.test.mjs — BRO-2218 acceptance.
 *
 * The fourth dispatch/close starvation mechanism: a card testing a TypeScript
 * module could only ever be ARMED with `node --test <file>.test.mjs` (the
 * allowlist's only TS-adjacent shape), and plain `node --test` cannot resolve
 * a module's own extensionless internal imports (tsconfig.json's
 * moduleResolution "bundler", no allowImportingTsExtensions) — so the armed
 * command fails ERR_MODULE_NOT_FOUND at close time no matter how correct the
 * work is. `npx tsx --test` (already this repo's own idiom — package.json's
 * test:unit script, test.yml's tsx-batch manifest) resolves that import shape
 * correctly, but isSafeCheckCommand refused it for `.test.ts` files
 * specifically — the exact extension `.test.ts` files in the tsx-batch
 * manifest actually use. This test proves the fix end to end: the shape is
 * accepted by the real allowlist, the real close-time verify plumbing
 * (verify-gate.js's evaluateVerifiability) arms a card that names it, and the
 * real executor (acceptance-check-core.js's runVerify) actually runs it and
 * gets a pass against a genuine multi-level extensionless-TS-import chain —
 * not a synthetic fixture. Unsafe shapes stay refused throughout.
 *
 * CLAUDE.md rule 15: require()s the real exported predicates, restates none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { isSafeCheckCommand, evaluateVerifiability } = require(path.join(REPO, 'scripts/lib/verify-gate.js'));
const { runVerify } = require(path.join(REPO, 'scripts/lib/acceptance-check-core.js'));

// tests/unit/show-date-line-parity.test.mjs is the repo's own worked example
// (Notion card 3b1637c5-416f-8184-bd0b-dbd6834b1a94): it imports
// src/lib/show-date-line.ts extensionlessly, which itself imports
// ./show-market and ./date-utils extensionlessly — a real two-level chain,
// not a one-off. tests/unit/show-market.test.ts is a genuine existing
// `.test.ts` file already run this exact way in test.yml's tsx-batch manifest
// (tests/unit-test-manifest-tsx.txt).
const MJS_CHAIN_TEST = 'tests/unit/show-date-line-parity.test.mjs';
const TS_FILE_TEST = 'tests/unit/show-market.test.ts';

test('the tsx runner shape now accepts .test.ts, not just .test.mjs/.test.js', () => {
  for (const ok of [
    `npx tsx --test ${TS_FILE_TEST}`,
    `npx tsx --test ${MJS_CHAIN_TEST}`,
    `npx tsx --test ${TS_FILE_TEST} ${MJS_CHAIN_TEST}`,
    'npx tsx --test --test-timeout 30000 tests/unit/engine.test.ts',
  ]) assert.equal(isSafeCheckCommand(ok), true, `${ok} should be safe`);
});

test('genuinely unsafe shapes stay refused — the fix widens ONE extension on ONE form, nothing else', () => {
  for (const bad of [
    // plain `node --test` on a .test.ts file: still refused for this form —
    // plain node has no TS-aware extensionless resolution, whatever the name
    `node --test ${TS_FILE_TEST}`,
    'npx tsx --test tests/unit/foo.test.tsx', // .tsx is not .ts
    'npx tsx --test tests/../src/lib/scoring.test.ts', // traversal
    'npx tsx --test /etc/passwd.test.ts', // outside pathPrefix
    `npx tsx --test ${TS_FILE_TEST} && curl evil.example`, // injection
    'node --import tsx --test tests/unit/foo.test.ts', // different shape, not the allowed idiom
  ]) assert.equal(isSafeCheckCommand(bad), false, `${bad} must be refused`);
});

test('evaluateVerifiability arms a card whose acceptance criteria names the tsx/.test.ts shape', () => {
  const notes = `## Problem\nSomething TS-shaped broke.\n\n## Acceptance criteria\nRun \`npx tsx --test ${TS_FILE_TEST}\` — passes.\n`;
  const v = evaluateVerifiability(notes);
  assert.equal(v.armed, true);
  assert.equal(v.cmd, `npx tsx --test ${TS_FILE_TEST}`);
  assert.equal(v.reason, null);
});

test('evaluateVerifiability still refuses to arm a card on the plain node --test .test.ts trap', () => {
  const notes = `## Acceptance criteria\nRun \`node --test ${TS_FILE_TEST}\` — passes.\n`;
  const v = evaluateVerifiability(notes);
  assert.equal(v.armed, false);
  assert.equal(v.cmd, null);
});

// ── the real executor, against the real repo — no mock, no synthetic fixture ─

test('runVerify actually PASSES the tsx/.test.ts shape against a genuine extensionless multi-level TS import chain', () => {
  const r = runVerify(REPO, `npx tsx --test ${MJS_CHAIN_TEST}`, { attempts: 1 });
  assert.equal(r.status, 'pass', `expected pass, got ${r.status}: ${r.detail}`);
});

test('runVerify actually PASSES a genuine .test.ts file the same way', () => {
  const r = runVerify(REPO, `npx tsx --test ${TS_FILE_TEST}`, { attempts: 1 });
  assert.equal(r.status, 'pass', `expected pass, got ${r.status}: ${r.detail}`);
});

test('runVerify reports the plain-node trap as unverifiable (refused at run-time re-validation), never a false pass', () => {
  const r = runVerify(REPO, `node --test ${TS_FILE_TEST}`, { attempts: 1 });
  assert.equal(r.status, 'unverifiable');
  assert.match(r.detail, /safe-form re-validation/);
});
