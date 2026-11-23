/**
 * Guard: theater page stat tiles must not stretch into tall empty boxes.
 *
 * The Past Shows / Avg Score row used hand-rolled `card ... text-center` tiles. On desktop
 * the "sm" ScoreBadge is 68px, the grid stretched the Past Shows tile to match, and the
 * number sat at the top of a tall empty box. Fixed by rendering the row through the shared
 * StatGrid, which pins labels to the top and centers the value block.
 *
 * Fails if any theater detail page (Broadway, Off-Broadway, West End, future markets)
 * goes back to hand-rolled tiles, or if StatGrid loses its centering / badge slot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findTheaterPages(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTheaterPages(p, out);
    else if (e.name === 'page.tsx' && /[\\/]theater[\\/]\[slug\][\\/]page\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const pages = findTheaterPages(path.join(root, 'src', 'app'));

test('finds the theater detail pages', () => {
  assert.ok(pages.length >= 3, `expected >= 3 theater pages, found ${pages.length}`);
});

for (const p of pages) {
  const rel = path.relative(root, p);
  test(`${rel} builds its stats row with StatGrid`, () => {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /<StatGrid\b/);
    assert.doesNotMatch(src, /card p-3 sm:p-4 text-center/);
  });
}

// Render the real component (no copied logic): transpile StatGrid.tsx and call it.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function loadStatGrid() {
  const src = fs.readFileSync(path.join(root, 'src/components/show-cards/StatGrid.tsx'), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', 'React', out)(require, mod.exports, mod, React);
  return mod.exports.StatGrid;
}
const StatGrid = loadStatGrid();
const html = props => renderToStaticMarkup(React.createElement(StatGrid, props));
const badge = React.createElement('span', { className: 'BADGE' }, '72');

test('a row with a badge node: labels on top, value block centered, subtitle wraps inside the tile', () => {
  const out = html({
    columns: 2,
    stats: [
      { label: 'Past Shows', value: 20, subtitle: 'a very long subtitle that must wrap' },
      { label: 'Avg Score', value: 72, node: badge },
    ],
  });
  assert.equal((out.match(/class="card [^"]*flex flex-col items-center"/g) || []).length, 2);
  assert.equal((out.match(/flex-1 w-full min-w-0 flex flex-col items-center justify-center/g) || []).length, 2);
  assert.match(out, /BADGE/);
  assert.match(out, /w-full break-words/);
  assert.doesNotMatch(out, /truncate/, 'a stretched-row subtitle wraps (a clipped "based on 2 sho…" label reads as a bug)');
  assert.ok(out.indexOf('Past Shows') < out.indexOf('>20<'), 'label comes before value');
});

test('a row with no node renders exactly as before (cast, critic, creative, biz pages)', () => {
  const out = html({
    stats: [
      { label: 'Highest', value: 91, subtitle: 'a very long subtitle that must truncate', subValue: '2nd' },
      { label: 'Lowest', value: 40 },
    ],
  });
  assert.doesNotMatch(out, /flex-col/);
  assert.doesNotMatch(out, /justify-center/);
  assert.match(out, /truncate/);
  assert.doesNotMatch(out, /break-words/);
  assert.match(out, /class="card p-2\.5 sm:p-4 text-center"/);
});

test('columns prop maps to literal Tailwind classes', () => {
  assert.match(html({ columns: 2, stats: [{ label: 'a', value: 1 }] }), /grid grid-cols-2 /);
  assert.match(html({ columns: 3, stats: [{ label: 'a', value: 1 }] }), /grid grid-cols-3 /);
  assert.match(html({ stats: [{ label: 'a', value: 1 }] }), /grid grid-cols-2 sm:grid-cols-4 /);
});

// --- Avg Score sample-size label (owner decision: keep the score, say how many shows it rests on) ---
function loadAvgScoreHelper() {
  const src = fs.readFileSync(path.join(root, 'src', 'lib', 'theater-avg-score.ts'), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', out)(mod.exports, mod);
  return mod.exports.getTheaterAvgScore;
}

test('getTheaterAvgScore: mean of scored shows, labeled with the sample size', () => {
  const get = loadAvgScoreHelper();
  const one = get([{ criticScore: { score: 78 } }, { criticScore: null }, {}]);
  assert.deepEqual(one, { avgScore: 78, sampleLabel: 'based on 1 show' });
  const many = get([{ criticScore: { score: 70 } }, { criticScore: { score: 81 } }, { criticScore: { score: 0 } }]);
  assert.equal(many.avgScore, 50);
  assert.equal(many.sampleLabel, 'based on 3 shows');
  assert.deepEqual(get([{ criticScore: null }, {}]), { avgScore: null });
});

for (const p of pages) {
  const rel = path.relative(root, p);
  test(`${rel} labels Avg Score with the sample size`, () => {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /getTheaterAvgScore\(theater\.allShows\)/);
    assert.match(src, /label: 'Avg Score'[^\n]*subtitle: avgScoreLabel/);
    assert.doesNotMatch(src, /scoredShows\s*=/, 'compute the average via getTheaterAvgScore, not inline');
  });
}

// Index pages (venue lists) must use the same helper, so the average is computed in one place.
function findTheaterIndexPages(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTheaterIndexPages(p, out);
    else if (e.name === 'page.tsx' && /[\\/]theater[\\/]page\.tsx$/.test(p)) out.push(p);
  }
  return out;
}
const indexPages = findTheaterIndexPages(path.join(root, 'src', 'app'));
test('finds the theater index pages', () => {
  assert.ok(indexPages.length >= 3, `expected >= 3 theater index pages, found ${indexPages.length}`);
});
for (const p of indexPages) {
  test(`${path.relative(root, p)} computes avgScore via getTheaterAvgScore`, () => {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /getTheaterAvgScore\(t\.allShows\)/);
    assert.doesNotMatch(src, /scoredShows\s*=/);
  });
}
