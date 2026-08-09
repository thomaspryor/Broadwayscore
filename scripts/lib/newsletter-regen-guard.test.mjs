// Tests for newsletter-regen-guard.js — require() the real function, never a copy.
//
// The last two assertions are the ones that matter: they run the guard over the
// REAL call sites, so if someone drops the NEWSLETTER_EDITION pin from
// pre-send-check.mjs or regression-test.mjs, this test goes red instead of the
// West End newsletter silently going missing from Resend (2026-08-08, 2026-07-25).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const { findUnpinnedGenerateSpawns } = require_('./newsletter-regen-guard.js');

test('flags an execFileSync spawn of generate.mjs with no edition pin', () => {
  const src = `
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EXCLUDE_SHOWS: ids.join(',') },
      stdio: 'pipe',
    });
  `;
  const v = findUnpinnedGenerateSpawns(src, 'fixture.mjs');
  assert.equal(v.length, 1);
  assert.equal(v[0].fn, 'execFileSync');
  assert.match(v[0].reason, /NEWSLETTER_EDITION/);
});

test('accepts the same spawn once NEWSLETTER_EDITION is pinned', () => {
  const src = `
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: draftEdition },
      stdio: 'pipe',
    });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('accepts an env object built above the call and passed by name', () => {
  const src = `
    const regenEnv = { ...process.env, NEWSLETTER_EXCLUDE_SHOWS: ids.join(','), NEWSLETTER_EDITION: draftEdition };
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], { cwd: repoRoot, env: regenEnv });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('accepts an env identifier pinned by later property assignment', () => {
  const src = `
    const regenEnv = { ...process.env };
    regenEnv.NEWSLETTER_EDITION = draftEdition;
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], { env: regenEnv });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('still flags an env identifier that never sets the edition', () => {
  const src = `
    const regenEnv = { ...process.env, NEWSLETTER_EXCLUDE_SHOWS: ids.join(',') };
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], { env: regenEnv });
  `;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('still flags a bare env: process.env passthrough', () => {
  const src = `execFileSync('node', [path.join(__dirname, 'generate.mjs'), w], { env: process.env });`;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('flags a spawn with a fully-qualified generator path', () => {
  const src = `spawnSync('node', ['scripts/newsletter/generate.mjs', weekStart], { env: process.env });`;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('flags a bare spawn() with no options object at all', () => {
  const src = `spawn('node', [path.join(dir, 'generate.mjs'), weekStart]);`;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('does NOT flag generate.mjs appearing only in an error message or comment', () => {
  const src = `
    // Re-run generate.mjs under this edition first.
    console.error('Generated HTML is the wrong edition — re-run generate.mjs first.');
    execFileSync('node', ['scripts/newsletter/pre-send-check.mjs', weekStart], { env: process.env });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('does NOT flag spawns of other scripts', () => {
  const src = `execFileSync('node', [path.join(__dirname, 'overflow-check.mjs'), weekStart], { env: process.env });`;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('real call site: pre-send-check.mjs pins the edition on its coverage-swap regen', () => {
  const p = path.join(repoRoot, 'scripts/newsletter/pre-send-check.mjs');
  const v = findUnpinnedGenerateSpawns(fs.readFileSync(p, 'utf8'), p);
  assert.deepEqual(v.map((x) => x.reason), []);
});

test('real call site: regression-test.mjs pins the edition on its re-run', () => {
  const p = path.join(repoRoot, 'scripts/newsletter/regression-test.mjs');
  const v = findUnpinnedGenerateSpawns(fs.readFileSync(p, 'utf8'), p);
  assert.deepEqual(v.map((x) => x.reason), []);
});

test('corpus sweep: no script under scripts/newsletter spawns the generator unpinned', () => {
  const dir = path.join(repoRoot, 'scripts/newsletter');
  const all = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    const p = path.join(dir, f);
    all.push(...findUnpinnedGenerateSpawns(fs.readFileSync(p, 'utf8'), `scripts/newsletter/${f}`));
  }
  assert.deepEqual(all.map((x) => x.reason), []);
});
