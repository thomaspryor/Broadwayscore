/**
 * Font wiring guard — scripts/check-font-integrity.js
 *
 * Background (2026-08-16): production served EVERY page in Times New Roman.
 * next/font/google names its class `__variable_<sha1(the CSS Google returns at
 * build time)>`. Google's Inter response drifts, and `.next/cache` is restored
 * across deploys (vercel-deploy.yml), so the JS module and the emitted CSS
 * asset came from different loader runs:
 *
 *   HTML: <html class="__variable_b9631e">
 *   CSS:  .__variable_d0be19{--font-inter:"__Inter_d0be19",...}
 *
 * `--font-inter` was undefined, and a bare var() makes the whole
 * `font-family: var(--font-inter), Inter, ...` declaration invalid at
 * computed-value time. CSS does NOT skip to the next family — the property
 * takes its INITIAL value. Hence serif, everywhere, on every page.
 *
 * tsc, lint, the build and every deploy health check passed throughout. These
 * tests pin the source shapes that let it happen, so neither half can return.
 * The runtime half of the coverage is tests/e2e/smoke.spec.ts, which asserts
 * the computed font in a real browser against production after each deploy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  splitTopLevel,
  normFamily,
  parseFontFaces,
  parseTailwindSans,
} from '../../scripts/check-font-integrity.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A minimal repo whose font wiring is correct; override pieces per test. */
function repoFixture({ css, tailwind, layout, fontFiles = ['fonts/i.woff2'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-wiring-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(
    'src/app/globals.css',
    css ??
      `@font-face{font-family:'InterVariable';src:url('/fonts/i.woff2') format('woff2');unicode-range:U+0000-00FF}\n` +
        `@font-face{font-family:'InterVariable Fallback';src:local('Arial');size-adjust:107.89%}\n`
  );
  write(
    'tailwind.config.ts',
    tailwind ??
      `export default {\n  theme: {\n    fontFamily: {\n      sans: [\n        'InterVariable',\n        'InterVariable Fallback',\n        'Arial',\n        'sans-serif',\n      ],\n    },\n  },\n}\n`
  );
  write('src/app/layout.tsx', layout ?? `const F = '/fonts/i.woff2';\nexport default function L() { return null; }\n`);
  for (const f of fontFiles) write(path.join('public', f), 'woff2-bytes');
  return dir;
}

const checks = (dir) => analyze({ root: dir }).failures.map((f) => f.check);

describe('font wiring: the real repo', () => {
  test('the checked-in source passes', () => {
    const { failures } = analyze({ root: REPO });
    assert.deepEqual(
      failures.map((f) => `${f.check}: ${f.detail}`),
      []
    );
  });
});

describe('font wiring: the 2026-08-16 incident shapes', () => {
  test('flags a next/font import — the hash-from-network mechanism', () => {
    const dir = repoFixture({
      layout: `import { Inter } from 'next/font/google';\nconst F = '/fonts/i.woff2';\n`,
    });
    assert.ok(checks(dir).includes('next-font-reintroduced'));
  });

  test('flags var() anywhere in the Tailwind sans stack', () => {
    // The declaration-poisoning half: one undefined property took out the
    // entire stack, including the Arial/sans-serif entries meant to save it.
    const dir = repoFixture({
      tailwind: `export default {\n  theme: {\n    fontFamily: {\n      sans: [\n        'var(--font-inter)',\n        'InterVariable',\n        'sans-serif',\n      ],\n    },\n  },\n}\n`,
    });
    assert.ok(checks(dir).includes('var-in-font-stack'));
  });

  test('flags a primary family with no @font-face backing it', () => {
    const dir = repoFixture({
      tailwind: `export default {\n  theme: {\n    fontFamily: {\n      sans: ['SomeBrandFont', 'Arial', 'sans-serif'],\n    },\n  },\n}\n`,
    });
    assert.ok(checks(dir).includes('primary-family-undefined'));
  });

  test('a commented-out next/font import is not a failure', () => {
    const dir = repoFixture({
      layout: `// import { Inter } from 'next/font/google';\n/* from 'next/font/google' */\nconst F = '/fonts/i.woff2';\n`,
    });
    assert.deepEqual(checks(dir), []);
  });
});

describe('font wiring: shipped assets and the duplicated filename', () => {
  test('flags an @font-face pointing at a file not in public/', () => {
    const dir = repoFixture({
      css: `@font-face{font-family:'InterVariable';src:url('/fonts/gone.woff2') format('woff2')}`,
      layout: `const F = '/fonts/gone.woff2';\n`,
    });
    assert.ok(checks(dir).includes('missing-font-file'));
  });

  test('flags a preload href that no @font-face uses — the hashes drifted', () => {
    // The filename hash is duplicated on purpose (deriving it would restore the
    // indirection that caused the incident), so the copies must be checked.
    const dir = repoFixture({ layout: `const F = '/fonts/i-OLDHASH.woff2';\n` });
    assert.ok(checks(dir).includes('preload-mismatch'));
  });

  test('flags a layout that preloads no font at all', () => {
    const dir = repoFixture({ layout: `export default function L() { return null; }\n` });
    assert.ok(checks(dir).includes('no-preload'));
  });

  test('flags a remote @font-face src — CSP sets font-src self', () => {
    const dir = repoFixture({
      css: `@font-face{font-family:'InterVariable';src:url('https://cdn.example/i.woff2') format('woff2')}`,
      layout: `const F = '/fonts/i.woff2';\n`,
    });
    const c = checks(dir);
    assert.ok(c.includes('remote-font-src'));
  });

  test('reports a missing source file instead of silently passing', () => {
    const dir = repoFixture();
    fs.rmSync(path.join(dir, 'tailwind.config.ts'));
    assert.ok(checks(dir).includes('missing-file'));
  });
});

describe('font wiring: parsing helpers', () => {
  test('splitTopLevel does not split inside var() fallbacks', () => {
    assert.deepEqual(
      splitTopLevel('var(--a, "X, Y"), Arial').map((s) => s.trim()),
      ['var(--a, "X, Y")', 'Arial']
    );
  });

  test('normFamily strips quotes and lowercases', () => {
    assert.equal(normFamily(" 'InterVariable' "), 'intervariable');
    assert.equal(normFamily('"Segoe UI"'), 'segoe ui');
  });

  test('parseFontFaces ignores font-family prose inside comments', () => {
    // globals.css documents the incident using the literal broken declaration;
    // parsing comments would make the guard hallucinate failures.
    const faces = parseFontFaces(
      `@font-face{font-family:'InterVariable';src:url('/fonts/i.woff2') format('woff2')}`
    );
    assert.deepEqual(faces, [{ family: 'intervariable', srcs: ['/fonts/i.woff2'] }]);
  });

  test('parseTailwindSans reads the sans array', () => {
    const sans = parseTailwindSans(
      `export default {\n  theme: {\n    fontFamily: {\n      sans: [\n        'InterVariable',\n        'Arial',\n      ],\n    },\n  },\n}\n`
    );
    assert.deepEqual(sans, ['InterVariable', 'Arial']);
  });
});
