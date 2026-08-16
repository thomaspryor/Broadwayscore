/**
 * Font integrity gate — scripts/check-font-integrity.js
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
 * `--font-inter` was therefore undefined, which makes the whole
 * `font-family: var(--font-inter), Inter, ...` declaration invalid at
 * computed-value time. CSS does NOT fall through to the next family in that
 * case — the property takes its INITIAL value. Hence serif, everywhere.
 *
 * tsc, lint, the build, and every deploy health check passed. These tests pin
 * the shapes the gate must catch so that stays true.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyze, splitTopLevel, normFamily } from '../../scripts/check-font-integrity.js';

/** Build a throwaway build-output dir: { 'a.css': '...', 'b.html': '...' }. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-integrity-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const checks = (r) => r.failures.map((f) => f.check);

describe('check-font-integrity: the 2026-08-16 incident shape', () => {
  test('flags a CSS var defined only under a class absent from the HTML', () => {
    // The exact production failure: hashes disagree between HTML and CSS.
    const dir = fixture({
      'app.css':
        '.__variable_d0be19{--font-inter:"__Inter_d0be19"}' +
        '@font-face{font-family:__Inter_d0be19;src:url(/f.woff2) format("woff2")}' +
        'html{font-family:var(--font-inter),Inter,ui-sans-serif,Arial,sans-serif}',
      'f.woff2': 'x',
      'index.html': '<html class="__variable_b9631e"><body>hi</body></html>',
    });
    const r = analyze(dir);
    assert.ok(checks(r).includes('unreachable-var'), 'must catch the hash mismatch');
  });

  test('passes when the HTML class matches the CSS class', () => {
    const dir = fixture({
      'app.css':
        '.__variable_d0be19{--font-inter:"__Inter_d0be19"}' +
        '@font-face{font-family:__Inter_d0be19;src:url(/f.woff2) format("woff2")}' +
        'html{font-family:var(--font-inter,Inter),Inter,ui-sans-serif,Arial,sans-serif}',
      'f.woff2': 'x',
      'index.html': '<html class="__variable_d0be19"><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });

  test('flags a font-family var that no CSS rule defines at all', () => {
    const dir = fixture({
      'app.css': 'html{font-family:var(--font-nope),Arial,sans-serif}',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.ok(checks(analyze(dir)).includes('undefined-var'));
  });

  test('flags bare var() with no inline fallback', () => {
    // A fallback inside var() keeps the declaration valid, so an undefined
    // property degrades to the rest of the stack instead of to serif.
    const dir = fixture({
      'app.css': ':root{--font-x:Inter}html{font-family:var(--font-x),Arial,sans-serif}',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.ok(checks(analyze(dir)).includes('var-without-fallback'));
  });
});

describe('check-font-integrity: shipped assets', () => {
  test('flags an @font-face pointing at a file missing from the build', () => {
    const dir = fixture({
      'app.css':
        "@font-face{font-family:'InterVariable';src:url('/fonts/gone.woff2') format('woff2')}" +
        "html{font-family:'InterVariable',Arial,sans-serif}",
      'index.html': '<html><body>hi</body></html>',
    });
    assert.ok(checks(analyze(dir)).includes('missing-font-file'));
  });

  test('flags a primary family with no @font-face and no system fallback status', () => {
    const dir = fixture({
      'app.css': "html{font-family:'SomeBrandFont',Arial,sans-serif}",
      'index.html': '<html><body>hi</body></html>',
    });
    assert.ok(checks(analyze(dir)).includes('no-font-face'));
  });

  test('accepts the current self-hosted setup', () => {
    const dir = fixture({
      'app.css':
        "@font-face{font-family:'InterVariable';src:url('/fonts/i.woff2') format('woff2');unicode-range:U+0000-00FF}" +
        "@font-face{font-family:'InterVariable Fallback';src:local('Arial');size-adjust:107.89%}" +
        "html{font-family:'InterVariable','InterVariable Fallback',Inter,ui-sans-serif,Arial,sans-serif}",
      'fonts/i.woff2': 'x',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });
});

describe('check-font-integrity: false-positive guards', () => {
  test('ignores font-family prose inside CSS comments', () => {
    // globals.css documents the incident using the literal broken declaration.
    // Unminified CSS keeps comments; parsing them would block every deploy.
    const dir = fixture({
      'app.css':
        '/* font-family: var(--font-inter), Inter — this is why it broke */' +
        "@font-face{font-family:'InterVariable';src:url('/f.woff2') format('woff2')}" +
        "html{font-family:'InterVariable',Arial,sans-serif}",
      'f.woff2': 'x',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });

  test('does not flag generic or OS-bundled families', () => {
    const dir = fixture({
      'app.css':
        'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
        'blockquote{font-family:Georgia,serif}' +
        'i{font-family:inherit}',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });

  test('only flags the PRIMARY family — later entries are optional hints', () => {
    // "use Inter if the user happens to have it installed" is a legitimate
    // stack entry, not a missing @font-face.
    const dir = fixture({
      'app.css': 'html{font-family:ui-sans-serif,Inter,Helvetica,sans-serif}',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });

  test('does not flag a var defined under a non-class selector', () => {
    // :root is always reachable; only class-only definitions need an HTML match.
    const dir = fixture({
      'app.css':
        ":root{--font-x:'InterVariable'}" +
        "@font-face{font-family:'InterVariable';src:url('/f.woff2') format('woff2')}" +
        'html{font-family:var(--font-x, Inter),Arial,sans-serif}',
      'f.woff2': 'x',
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });

  test('treats remote and data: font sources as present', () => {
    const dir = fixture({
      'app.css':
        "@font-face{font-family:'InterVariable';src:url('https://cdn.example/i.woff2') format('woff2')}" +
        "html{font-family:'InterVariable',Arial,sans-serif}",
      'index.html': '<html><body>hi</body></html>',
    });
    assert.deepEqual(analyze(dir).failures, []);
  });
});

describe('check-font-integrity: parsing helpers', () => {
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

  test('an output dir with no HTML is a failure, not a silent pass', () => {
    // If the gate is ever pointed at the wrong build directory it must say so
    // loudly rather than reporting "no problems found".
    const dir = fixture({ 'app.css': 'html{font-family:Arial,sans-serif}' });
    assert.ok(checks(analyze(dir)).includes('no-html'));
  });
});
