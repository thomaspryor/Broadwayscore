// BRO-7676: the opening-night lane writes outlet--critic--on-<night>.json and the
// build uses that file, so the review's live row maps to the canonical name, not the
// lane file's. review-count-match read every lane file as a missing, unlogged
// review and, at 5+, raised an error that held tonight's Resend draft (The
// Fantasticks, 2026-11-17). Files whose URL is live in the build are not missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/review-count-match.check.js');
const SHOW = 'bro-7676-url-match-test-show';

function setup(n, { urlLive }) {
  const root = mkdtempSync(path.join(tmpdir(), 'rcm-url-'));
  mkdirSync(path.join(root, SHOW));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const url = `https://outlet${i}.example.com/reviews/${SHOW}-review/`;
    // Lane twin: the file the build used.
    writeFileSync(path.join(root, SHOW, `outlet${i}--critic-${i}--on-2026-11-16.json`), JSON.stringify({ url }));
    // Canonical file, marked duplicateOf the lane file.
    writeFileSync(path.join(root, SHOW, `outlet${i}--critic-${i}.json`), JSON.stringify({ url, duplicateOf: `outlet${i}--critic-${i}--on-2026-11-16.json` }));
    rows.push({ outletId: `outlet${i}`, criticName: `Critic ${i}`, url: urlLive ? `${url}?utm_source=x` : `https://elsewhere.example.com/${i}` });
  }
  return { root, rows };
}

test('lane twin files whose URL is live do not raise an error', () => {
  const { root, rows } = setup(6, { urlLive: true });
  try {
    const r = check.run({ id: SHOW, title: 'T' }, { reviewTextsRoot: root, reviewsDoc: { [SHOW]: rows }, now: new Date('2026-11-17T06:00:00Z') });
    assert.notEqual(r.severity, 'error', r.message);
    assert.doesNotMatch(r.message, /--on-2026-11-16\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same URL under a different outlet does not count as present', () => {
  const { root, rows } = setup(6, { urlLive: true });
  try {
    const other = rows.map(r => ({ ...r, outletId: `other-${r.outletId}` }));
    const res = check.run({ id: SHOW, title: 'T' }, { reviewTextsRoot: root, reviewsDoc: { [SHOW]: other }, now: new Date('2026-11-17T06:00:00Z') });
    assert.equal(res.severity, 'error', res.message);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file whose URL is not in the build is still reported', () => {
  const { root, rows } = setup(6, { urlLive: false });
  try {
    const r = check.run({ id: SHOW, title: 'T' }, { reviewTextsRoot: root, reviewsDoc: { [SHOW]: rows }, now: new Date('2026-11-17T06:00:00Z') });
    assert.equal(r.severity, 'error', r.message);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
