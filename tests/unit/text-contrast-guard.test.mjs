// BRO-6553: dim gray text (text-gray-500/600) fails WCAG AA. scripts/audit-text-contrast.js
// is the guard; this runs it in the unit-test gate so a new text-gray-500 line fails the land.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no text-gray-500/600 text in src (use text-fg-muted)', () => {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['scripts/audit-text-contrast.js'], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    assert.fail(`${e.stdout || ''}${e.stderr || ''}`.split('\n').slice(0, 12).join('\n'));
  }
  assert.match(out, /^OK:/m);
});
