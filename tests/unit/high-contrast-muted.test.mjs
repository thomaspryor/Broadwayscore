// BRO-6567: OS "Increase Contrast" (prefers-contrast: more) lifts muted text to >= 10:1 on
// every surface. Requires the real checker (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkHighContrast, HC_MIN } = require('../../scripts/lib/text-contrast.js');

test('globals.css lifts fg-muted to >= 10:1 under prefers-contrast: more', () => {
  const { failures, covered } = checkHighContrast();
  assert.deepStrictEqual(failures, []);
  assert.ok(covered.includes('.text-fg-muted') && covered.length >= 2, `covered: ${covered}`);
  assert.strictEqual(HC_MIN, 10);
});

test('reports a missing block, a dim color and an uncovered @apply class', () => {
  assert.deepStrictEqual(checkHighContrast(undefined, '.a{color:red}').failures,
    ['no @media (prefers-contrast: more) block in globals.css']);
  const dim = checkHighContrast(undefined, '@media (prefers-contrast: more) { .text-fg-muted { color: #b8bec9; } }');
  assert.ok(dim.failures.some((f) => /surface\.elevated/.test(f)), dim.failures.join('\n'));
  const css = '  .chip {\n    @apply text-xs text-fg-muted;\n  }\n@media (prefers-contrast: more) { .text-fg-muted { color: #e5e7eb; } }';
  assert.deepStrictEqual(checkHighContrast(undefined, css).failures,
    ['.chip has no high-contrast color in @media (prefers-contrast: more)']);
});
