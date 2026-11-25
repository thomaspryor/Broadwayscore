// BRO-8324 (owner decision 2026-11-25, option A): reviews of preview performances count.
// The anticipatory ingest gate used to reject any review dated more than 2 days before
// openingDate, so Rolandcat's Afronauts review (Nov 17, previews started Nov 14) was
// dropped while Monstagigz's (Nov 15) was counted. These tests pin the gate and make
// sure every caller passes previewsStartDate, so the gate and its re-checks agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isAnticipatoryPreviewPost, PREVIEW_START_MAX_LEAD_DAYS } = require('./content-filters.js');

const WE = { category: 'west-end', previewsStartDate: '2026-11-14' };
const OPEN = '2026-11-23';

test('Afronauts: a review during previews is not anticipatory (Rolandcat, Nov 17)', () => {
  assert.equal(isAnticipatoryPreviewPost('2026-11-17', OPEN, 'rolandcat', WE).rejected, false);
});

test('Afronauts: Monstagigz and Rolandcat get the same verdict', () => {
  const a = isAnticipatoryPreviewPost('2026-11-15', OPEN, 'monstagigz', WE).rejected;
  const b = isAnticipatoryPreviewPost('2026-11-17', OPEN, 'rolandcat', WE).rejected;
  assert.equal(a, b);
});

test('a post dated before the first preview is still rejected', () => {
  const r = isAnticipatoryPreviewPost('2026-11-10', OPEN, 'rolandcat', WE);
  assert.equal(r.rejected, true);
  assert.equal(r.daysBeforeOpening, 13);
});

test('without previewsStartDate the old 2-day grace still applies (no behavior change)', () => {
  assert.equal(isAnticipatoryPreviewPost('2026-11-17', OPEN, 'rolandcat', { category: 'west-end' }).rejected, true);
  assert.equal(isAnticipatoryPreviewPost('2026-11-21', OPEN, 'rolandcat', { category: 'west-end' }).rejected, false);
});

test('preview-heavy outlets keep the strict gate even after previews start', () => {
  const r = isAnticipatoryPreviewPost('2026-11-17', OPEN, 'frontmezzjunkies', WE);
  assert.equal(r.rejected, true);
  assert.equal(r.outletCategory, 'preview-heavy');
});

test('a previewsStartDate far before opening (interrupted run) is ignored', () => {
  const lead = PREVIEW_START_MAX_LEAD_DAYS + 40;
  const ps = new Date(Date.parse(OPEN) - lead * 86400000).toISOString().slice(0, 10);
  const mid = new Date(Date.parse(OPEN) - (lead - 10) * 86400000).toISOString().slice(0, 10);
  assert.equal(isAnticipatoryPreviewPost(mid, OPEN, 'rolandcat', { category: 'west-end', previewsStartDate: ps }).rejected, true);
});

test('a previewsStartDate after openingDate or unparseable is ignored', () => {
  assert.equal(isAnticipatoryPreviewPost('2026-11-17', OPEN, 'x', { category: 'west-end', previewsStartDate: '2026-12-01' }).rejected, true);
  assert.equal(isAnticipatoryPreviewPost('2026-11-17', OPEN, 'x', { category: 'west-end', previewsStartDate: 'nonsense' }).rejected, true);
});

test('humanReviewedEarlyPublish still bypasses everything', () => {
  assert.equal(isAnticipatoryPreviewPost('2026-01-01', OPEN, 'x', { ...WE, humanReviewedEarlyPublish: true }).rejected, false);
});

// Class guard: any caller that forgets previewsStartDate would re-reject (or re-flag on
// rebuild) the reviews this gate now admits. Scan every non-test caller.
test('every isAnticipatoryPreviewPost caller passes previewsStartDate', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
    }
  })(root);
  const offenders = [];
  let calls = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (f.endsWith('content-filters.js')) continue; // the definition
    const re = /isAnticipatoryPreviewPost\(/g;
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 3), m.index);
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      // skip comment mentions: line starts with // or *
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index))) continue;
      calls++;
      const window = src.slice(m.index, m.index + 900);
      if (!/previewsStartDate/.test(window)) offenders.push(`${path.relative(root, f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(calls >= 5, `expected to find the known callers, found ${calls}`);
  assert.deepEqual(offenders, [], `callers missing previewsStartDate: ${offenders.join(', ')}`);
});
