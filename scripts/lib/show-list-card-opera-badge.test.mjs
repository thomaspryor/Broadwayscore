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
const { showsMarketBadge, searchPillMarket } = require('./market-badge.js');
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
  fs.writeFileSync(f, [
    '<div>{x && <CategoryBadge category="off-west-end" />}</div>',
    '<CategoryBadge category={c} isOpera={o} />',
    '<CategoryBadge',
    '  category={show.category}',
    '/>',
    '<CategoryBadge',
    '  category={show.category}',
    '  isOpera={isOperaShow(show)}',
    '/>',
  ].join('\n'));
  try {
    const bad = categoryBadgeCallsitesMissingIsOpera([f]);
    assert.deepEqual(bad.map((b) => b.replace(/^.*Card\.tsx/, 'Card.tsx')), ['Card.tsx:1', 'Card.tsx:3']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ShowListCard Off-WE badge is wired through isOpera', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/components/show-cards/ShowListCard.tsx'), 'utf8');
  assert.match(src, /<CategoryBadge\s+category="off-west-end"\s+isOpera=\{isOpera\}\s*\/>/);
});

test('search dropdown pill: operas read "Opera", everything else keeps its market', () => {
  assert.equal(searchPillMarket('off-broadway', true), 'opera');
  assert.equal(searchPillMarket('west-end', true), 'opera');
  assert.equal(searchPillMarket('off-west-end', false), 'off-west-end');
  assert.equal(searchPillMarket('regional', false), 'regional');
  assert.equal(searchPillMarket(undefined, false), 'broadway');
});

// Class guard for the hand-rolled cousins (HeaderSearch, ShowSearchDropdown,
// CompareShowPicker all labelled Met operas "Off-Bway"): no src/ file may map
// show.category straight to a market label; it goes through searchPillMarket
// or showsMarketBadge first.
export function rawCategoryLabelSites(files) {
  const bad = [];
  const re = /show\.category\s*===\s*'(off-broadway|off-west-end|west-end)'\s*\?\s*'(Off-Bway|Off-West End|West End)'/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    const lines = src.split('\n');
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      // Allowed when the enclosing condition (same or previous line) already ran showsMarketBadge.
      if (/showsMarketBadge\(/.test(lines[line - 1] + lines[line - 2])) continue;
      const site = `${path.relative(repoRoot, f)}:${line}`;
      if (!bad.includes(site)) bad.push(site);
    }
  }
  return bad;
}

test('no src/ file maps show.category straight to a market label', () => {
  assert.deepEqual(rawCategoryLabelSites(walk(path.join(repoRoot, 'src'))), []);
});

test('search-shows generator marks operas so the dropdowns can tell', () => {
  const gen = fs.readFileSync(path.join(repoRoot, 'scripts/generate-search-shows.js'), 'utf8');
  assert.equal((gen.match(/if \(show\.type === 'opera'\) entry\.type = 'opera';/g) || []).length, 2,
    'both the visible-show and archive entries must carry type for operas');
});
