// BRO-7902: the visual gate must not ask the owner about text-only formatting changes (BRO-7890: "Mar 1, 2016" -> "Mar 2016"),
// but layout, color, spacing and component changes must still need the owner's yes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const D = require('../../scripts/lib/visual-design-diff.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = !D._loadTs() && 'typescript not installed (classifier fails closed)';
const F = 'src/components/X.tsx';
const cls = (a, b) => D.classifyFile({ file: F, oldSource: a, newSource: b });

const BASE = `
function formatDate(d: string) { const m = ['Jan','Feb']; return m[0] + ' ' + d; }
export default function X({ d }: { d: string }) { return <div className="p-2 text-sm">{formatDate(d)}</div>; }
`;

test('BRO-7890 real commit (formatter body swapped for shared helper): no owner approval', { skip: SKIP }, () => {
  const sha = 'cd20b420d68';
  try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); } catch { return; } // shallow clone
  const r = D.designFiles(`${sha}^...${sha}`, ['src/components/ReviewsList.tsx'], ROOT);
  assert.deepEqual(r, []);
});

test('text-only formatting helper body change: not design', { skip: SKIP }, () => {
  const next = BASE.replace("m[0] + ' ' + d", "m[0] + ', ' + d.slice(0, 4)");
  assert.equal(cls(BASE, next).design, false);
});

test('formatter swapped for an alias of an imported helper: not design', { skip: SKIP }, () => {
  const next = `import { formatReviewDate } from '@/lib/date-utils';
const formatDate = formatReviewDate;
export default function X({ d }: { d: string }) { return <div className="p-2 text-sm">{formatDate(d)}</div>; }
`;
  assert.equal(cls(BASE, next).design, false);
});

for (const [name, next] of [
  ['class color change', BASE.replace('text-sm', 'text-red-500')],
  ['spacing change', BASE.replace('p-2', 'p-6')],
  ['new component/element', BASE.replace('<div className="p-2 text-sm">', '<div className="p-2 text-sm"><Badge/>')],
  ['call site changed to a different helper', BASE.replace('{formatDate(d)}', '{formatOther(d)}')],
  ['helper that renders JSX', BASE.replace("return m[0] + ' ' + d;", 'return <b className="text-red-500">{d}</b>;')],
  ['helper that writes style', BASE.replace("return m[0]", "document.body.style.color = 'red'; return m[0]")],
  ['non-format helper body (class picker)', `function pickClass(){ return 'a'; }\nexport default function X(){ return <div className={pickClass()}/>; }`
    .replace("'a'", "'a'") ],
]) {
  test(`still design: ${name}`, { skip: SKIP }, () => {
    const old = name.startsWith('non-format') ? next : BASE;
    const nw = name.startsWith('non-format') ? next.replace("'a'", "'text-red-500'") : next;
    assert.equal(cls(old, nw).design, true);
  });
}
