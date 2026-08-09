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

test('flags the shell-string form execSync uses', () => {
  const src = "execSync('node scripts/newsletter/generate.mjs ' + weekStart, { env: process.env });";
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('flags the template-literal shell form', () => {
  const src = 'execSync(`node scripts/newsletter/generate.mjs ${weekStart}`);';
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('an apostrophe in a comment inside the call does not hide the violation', () => {
  const src = `
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
      // don't forget the cwd here
      cwd: repoRoot,
      env: { ...process.env },
    });
  `;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('a comment naming NEWSLETTER_EDITION does not count as a pin', () => {
  const src = `
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
      // NEWSLETTER_EDITION is set by the workflow
      env: { ...process.env },
    });
  `;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('resolves a pin through a spread identifier in an inline env object', () => {
  const src = `
    const base = { ...process.env, NEWSLETTER_EDITION: draftEdition };
    execFileSync('node', [path.join(__dirname, 'generate.mjs'), w], { env: { ...base, OTHER: 1 } });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('does NOT flag generate.mjs appearing only in an error message or comment', () => {
  const src = `
    // Re-run generate.mjs under this edition first.
    console.error('Generated HTML is the wrong edition — re-run generate.mjs first.');
    execFileSync('node', ['scripts/newsletter/pre-send-check.mjs', weekStart], { env: process.env });
  `;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('flags a spawn whose generator path is held in a variable', () => {
  const src = `
    const generator = path.join(__dirname, 'generate.mjs');
    execFileSync('node', [generator, weekStart], { env: process.env });
  `;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('does NOT flag generate.mjs passed as DATA to a different program', () => {
  const src = `execFileSync('node', ['scripts/tool.mjs', 'generate.mjs'], { env: process.env });`;
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

// Regex literals are the dangerous direction: mis-lexing one as a comment
// blanks the rest of the line and hides any spawn after it (Codex, 2026-08-09).
test('a regex literal containing // does not hide a later unpinned spawn', () => {
  const src = [
    'const r = /[//]/;',
    "execFileSync('node', ['generate.mjs'], { env: process.env });",
  ].join('\n');
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('a regex literal containing quotes does not hide a later unpinned spawn', () => {
  const src = [
    'const r = /[\'"]/;',
    "execFileSync('node', ['generate.mjs'], { env: process.env });",
  ].join('\n');
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('an escaped-backslash string in the options does not hide the violation', () => {
  const src = String.raw`execFileSync('node', ['generate.mjs'], { cwd: "C:\\", env: process.env });`;
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('does NOT flag a spawn that only appears inside a string literal', () => {
  const src = "const doc = \"execFileSync('node', ['generate.mjs'], {env: process.env})\";";
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

test('a URL inside a string is not treated as a line comment', () => {
  const src = [
    "const u = 'https://example.com/x';",
    "execFileSync('node', ['generate.mjs'], { env: process.env });",
  ].join('\n');
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

test('division is still treated as division, not a regex', () => {
  const src = [
    'const ratio = total / count;',
    "execFileSync('node', ['generate.mjs'], { env: { ...process.env, NEWSLETTER_EDITION: e } });",
  ].join('\n');
  assert.deepEqual(findUnpinnedGenerateSpawns(src, 'fixture.mjs'), []);
});

// Template interpolation is CODE — a spawn nested in `${...}` is a real call
// site, not string content (Codex round 3, 2026-08-09).
test('flags a spawn nested in a template interpolation', () => {
  const src = "const t = `${execFileSync('node', ['generate.mjs'], { env: process.env })}`;";
  assert.equal(findUnpinnedGenerateSpawns(src, 'fixture.mjs').length, 1);
});

// Documented limit, asserted so it stays a known quantity rather than a
// surprise: argv assembled at runtime is out of this scanner's reach. See the
// KNOWN LIMIT note in newsletter-regen-guard.js for why no net guards it.
test('KNOWN LIMIT: runtime-assembled argv is not checked', () => {
  const src = "const args = []; execFileSync('node', [...args, 'generate.mjs'], { env: process.env });";
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

// Sweep every plausible home for a generator spawn, not just scripts/newsletter —
// a helper under scripts/lib or a one-off in scripts/ root can spawn it just as
// easily, and that is precisely the "third call site" this guard exists for.
test('corpus sweep: nothing under scripts/newsletter, scripts/lib, or scripts/ root spawns the generator unpinned', () => {
  const dirs = ['scripts/newsletter', 'scripts/lib', 'scripts'];
  const all = [];
  let scanned = 0;
  for (const rel of dirs) {
    const dir = path.join(repoRoot, rel);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(f)) continue;
      // Test files carry deliberately-unpinned fixtures (including this one).
      if (/\.test\.(mjs|js)$/.test(f)) continue;
      const p = path.join(dir, f);
      if (!fs.statSync(p).isFile()) continue;
      scanned++;
      all.push(...findUnpinnedGenerateSpawns(fs.readFileSync(p, 'utf8'), `${rel}/${f}`));
    }
  }
  // Vacuous-guard check: a sweep that scanned nothing must not read as a pass.
  assert.ok(scanned > 50, `expected to scan >50 scripts, scanned ${scanned}`);
  assert.deepEqual(all.map((x) => x.reason), []);
});
