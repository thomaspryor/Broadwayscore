// BRO-7313: an opera never shows a market pill (OPERA + Off-WE side by side was the bug).
// Two layers: the pure decision (showsMarketBadge) and a source scan that every
// <CategoryBadge> callsite in src/ passes isOpera, so a new callsite can't
// silently skip the decision the way ShowListCard's Off-WE badge did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { showsMarketBadge } = require('./market-badge.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('opera shows never get a market pill, whatever their category', () => {
  for (const cat of ['off-west-end', 'west-end', 'off-broadway', 'regional', 'tour', 'broadway', undefined]) {
    assert.equal(showsMarketBadge(cat, true), false, `opera + ${cat}`);
  }
});

test('non-opera shows keep their market pill; Broadway and missing category have none', () => {
  for (const cat of ['off-west-end', 'west-end', 'off-broadway', 'regional', 'tour']) {
    assert.equal(showsMarketBadge(cat, false), true, cat);
  }
  assert.equal(showsMarketBadge('broadway', false), false);
  assert.equal(showsMarketBadge(undefined, false), false);
  assert.equal(showsMarketBadge('', false), false);
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Exported for the red-then-green check below.
export function categoryBadgeCallsitesMissingIsOpera(files) {
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /<CategoryBadge\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(src))) {
      if (!/\bisOpera\s*=/.test(m[1])) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${path.relative(repoRoot, f)}:${line}`);
      }
    }
  }
  return bad;
}

test('every <CategoryBadge> callsite in src/ passes isOpera', () => {
  const files = walk(path.join(repoRoot, 'src'));
  const callsites = files.filter((f) => fs.readFileSync(f, 'utf8').includes('<CategoryBadge'));
  assert.ok(callsites.length >= 3, `expected the known callsites, found ${callsites.length}`);
  assert.deepEqual(categoryBadgeCallsitesMissingIsOpera(files), []);
});

test('the scan catches a callsite without isOpera (guards the guard)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'bro7313-'));
  const f = path.join(tmp, 'Card.tsx');
  fs.writeFileSync(f, '<div>{x && <CategoryBadge category="off-west-end" />}</div>\n<CategoryBadge category={c} isOpera={o} />');
  try {
    const bad = categoryBadgeCallsitesMissingIsOpera([f]);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /Card\.tsx:1$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ShowListCard Off-WE badge is wired through isOpera', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/components/show-cards/ShowListCard.tsx'), 'utf8');
  assert.match(src, /<CategoryBadge category="off-west-end" isOpera=\{isOpera\} \/>/);
});
