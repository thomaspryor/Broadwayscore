// BRO-6567: advisory web font-floor lint. Requires the real function (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findViolations } = require('../../scripts/lint-font-floor.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('flags 9/10/11px, not 12px or text-xs', () => {
  const src = '<a className="text-[9px]"/>\n<b className="text-[10px] text-[11px]"/>\n<c className="text-[12px] text-xs text-[14px]"/>';
  const v = findViolations(src);
  assert.deepStrictEqual(v.map(x => [x.line, x.px]), [[1, 9], [2, 10], [2, 11]]);
});

test('font-floor-ok on the same or previous line exempts', () => {
  const src = '{/* font-floor-ok: decorative tick */}\n<a className="text-[9px]"/>\n<b className="text-[10px]"/> // font-floor-ok: logo';
  assert.deepStrictEqual(findViolations(src), []);
});

test('CLI is advisory: prints a count and exits 0 on the real tree', () => {
  const out = execFileSync(process.execPath, ['scripts/lint-font-floor.js'], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /^ADVISORY font floor \(12px\): \d+ sub-floor use/m);
});
