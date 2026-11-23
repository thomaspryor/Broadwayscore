// BRO-8169: a UI diff whose only change is ADDING `await` (with its parentheses) or `async` around non-JSX
// expressions is a fix, not a design change. The real case: BRO-8056 p2 made getShowForRender async, and the
// show page + OG image were flagged "layout/style changed near ParenthesizedExpression", so the owner had to
// say yes to identical pictures again.
// The exemption is insert-only: removing an await (a Promise then reaches a condition or a class) stays design,
// and `async` alone stays design unless its JSX-free function body also gained an await.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const D = require('../../scripts/lib/visual-design-diff.js');
const FIX = join(HERE, '..', '..', 'scripts', 'lib', 'fixtures', 'bro-8169');
const SKIP_TS = !D._loadTs() && 'typescript is not installed (the classifier fails closed without it)';

const wrap = (body, head = "import {A,B} from 'a'; import {f,g,cache} from './u';") => `${head} export default async function X(){${body}}`;
const classify = (a, b, opts = {}) => D.classifyFile({ file: opts.file || 'src/x.tsx', oldSource: (opts.headA ?? '') + wrap(a, opts.head), newSource: (opts.headB ?? '') + wrap(b, opts.head) });
const read = (f) => readFileSync(join(FIX, f), 'utf8');

const FIX_CASES = {
  'await added to a data getter': [`const r = f(s); return <A r={r}/>;`, `const r = await f(s); return <A r={r}/>;`],
  'await added with parentheses before optional chaining': [`const r = f(s)?.show; return <A r={r}/>;`, `const r = (await f(s))?.show; return <A r={r}/>;`],
  'async + await added inside a cache() getter, caller awaits too': [`const h = cache((s) => { const v = f(s)?.show; return v; }); const x = h(s); return <A x={x}/>;`, `const h = cache(async (s) => { const v = (await f(s))?.show; return v; }); const x = await h(s); return <A x={x}/>;`],
  'async helper in a file that also re-exports something else': [`const h = (s) => { const v = f(s); return v; }; const x = await h(s); return <A x={x}/>;`, `const h = async (s) => { const v = await f(s); return v; }; const x = await h(s); return <A x={x}/>;`, "export { B as B2 };"],
  'await added inside a parenthesised getter that was already parenthesised': [`const r = (f(s))?.show; return <A r={r}/>;`, `const r = (await f(s))?.show; return <A r={r}/>;`],
  // Accepted residual (documented in visual-design-diff.js): the BRO-8056 shape, a guard on the awaited const.
  'await added to a const that a not-found guard then checks': [`const r = f(s); if (!r) return null; return <A r={r}/>;`, `const r = await f(s); if (!r) return null; return <A r={r}/>;`],
  'await added to a getter result then used': [`const hd = g(s); return <A line={hd.line}/>;`, `const hd = await g(s); return <A line={hd.line}/>;`],
};
for (const [name, [a, b, tail]] of Object.entries(FIX_CASES)) {
  test(`fix: ${name}`, { skip: SKIP_TS }, () => {
    const r = tail ? D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a) + tail, newSource: wrap(b) + tail }) : classify(a, b);
    assert.equal(r.design, false, r.reason);
  });
}

const DESIGN_CASES = {
  'await added next to a className change': [`const r = f(s); return <div className="p-2"><A r={r}/></div>;`, `const r = await f(s); return <div className="p-4"><A r={r}/></div>;`],
  'await removed (a Promise now reaches the condition)': [`const on = await f(); return on && <A/>;`, `const on = f(); return on && <A/>;`],
  'await removed feeding a class': [`const c = await f(); return <div className={c}/>;`, `const c = f(); return <div className={c}/>;`],
  'await added as a JSX child': [`return <div>{f()}</div>;`, `return <div>{await f()}</div>;`],
  'await added whose operand holds JSX': [`const el = f(<A/>); return el;`, `const el = await f(<A/>); return el;`],
  'async added with no await in the function': [`const h = cache((s) => f(s)); return <A h={h}/>;`, `const h = cache(async (s) => f(s)); return <A h={h}/>;`],
  'async added to a JSX-returning function': [`const C = () => { const v = f(); return <A v={v}/>; }; return <C/>;`, `const C = async () => { const v = await f(); return <A v={v}/>; }; return <C/>;`],
  'async added to a helper that a caller still calls without await': [`const h = cache((s) => { const v = f(s); return v; }); const x = h(s); return <A x={x}/>;`, `const h = cache(async (s) => { const v = await f(s); return v; }); const x = h(s); return <A x={x}/>;`],
  'async added to a helper passed by reference': [`const h = (s) => { const v = f(s); return v; }; return <A h={h}/>;`, `const h = async (s) => { const v = await f(s); return v; }; return <A h={h}/>;`],
  'async added to an inline callback': [`const v = L.map((s) => { const r = f(s); return r; }); return <A v={v}/>;`, `const v = L.map(async (s) => { const r = await f(s); return r; }); return <A v={v}/>;`],
  'await added inside an if condition': [`if (f()) return null; return <A/>;`, `if (await f()) return null; return <A/>;`],
  'await added in a ternary condition': [`return f() ? <A/> : <B/>;`, `return (await f()) ? <A/> : <B/>;`],
  'await added to a const that feeds className': [`const c = f(); return <div className={c}/>;`, `const c = await f(); return <div className={c}/>;`],
  'async added to a class method': [`class K { m(){ const v = f(); return v; } } return <A/>;`, `class K { async m(){ const v = await f(); return v; } } return <A/>;`],
  'async helper exported by name': [`const h = (s) => { const v = f(s); return v; }; return <A/>;`, `const h = async (s) => { const v = await f(s); return v; }; return <A/>;`, "export { h };"],
  'parenthesised grouping changed (no await)': [`const n = (a + b) * c; return <A n={n}/>;`, `const n = a + b * c; return <A n={n}/>;`],
  'await plus a new identifier': [`const r = f(s); return <A r={r}/>;`, `const r = await f(s) ?? fallback; return <A r={r}/>;`],
};
for (const [name, [a, b, tail]] of Object.entries(DESIGN_CASES)) {
  test(`design (fail closed): ${name}`, { skip: SKIP_TS }, () => {
    const r = tail ? D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a) + tail, newSource: wrap(b) + tail }) : classify(a, b);
    assert.equal(r.design, true, r.reason);
  });
}

test('a string literal that starts with ~ cannot pose as an inserted token', { skip: SKIP_TS }, () => {
  assert.equal(classify(`const r = f(s); return <A r={r}/>;`, `const q = "~AwaitExpression"; const r = f(s); return <A r={r}/>;`).design, true);
});
test('kill switch passed through the env option (as selfClear does) also disables it', { skip: SKIP_TS }, () => {
  const o = D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(`const r = f(s); return <A r={r}/>;`), newSource: wrap(`const r = await f(s); return <A r={r}/>;`), env: { VISUAL_AWAIT_TRANSPARENT_DISABLED: '1' } });
  assert.equal(o.design, true);
});
test('kill switch VISUAL_AWAIT_TRANSPARENT_DISABLED=1 makes an added await design again', { skip: SKIP_TS }, () => {
  process.env.VISUAL_AWAIT_TRANSPARENT_DISABLED = '1';
  try { assert.equal(classify(`const r = f(s); return <A r={r}/>;`, `const r = await f(s); return <A r={r}/>;`).design, true); }
  finally { delete process.env.VISUAL_AWAIT_TRANSPARENT_DISABLED; }
});

// Real BRO-8056 p2 files (commit b0deb852d, branch land/bro-8056-p2-reader), stored as fixtures.
test('real BRO-8056 p2: opengraph-image.tsx (its whole diff is one added await) is fix-only', { skip: SKIP_TS }, () => {
  const r = D.classifyFile({ file: 'src/app/show/[slug]/opengraph-image.tsx', oldSource: read('opengraph-image.before.tsx.txt'), newSource: read('opengraph-image.after.tsx.txt') });
  assert.equal(r.design, false, r.reason);
});
test('real BRO-8056 p2: page.tsx with only its await/async hunks is fix-only', { skip: SKIP_TS }, () => {
  const r = D.classifyFile({ file: 'src/app/show/[slug]/page.tsx', oldSource: read('page.before.tsx.txt'), newSource: read('page.after-await-hunks.tsx.txt') });
  assert.equal(r.design, false, r.reason);
});
test('real BRO-8056 p2: the FULL page.tsx diff stays design (it also adds `!refreshed` conditions that hide the rank cards)', { skip: SKIP_TS }, () => {
  const r = D.classifyFile({ file: 'src/app/show/[slug]/page.tsx', oldSource: read('page.before.tsx.txt'), newSource: read('page.full-after.tsx.txt') });
  assert.equal(r.design, true, r.reason);
  assert.doesNotMatch(r.reason, /ParenthesizedExpression|AwaitExpression/, 'the await itself is no longer the reason: ' + r.reason);
});
