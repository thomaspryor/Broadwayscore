// BRO-3508 / BRO-3598: rebuild-exclusion-audit helpers.
// - summarizeShowExclusionsForPrompt feeds analyze-rebuild-drops.js the files
//   the rebuild actually dropped, instead of bare counts.
// - buildExclusionTotals / mergeDailyTotals / readDailyTotals back the
//   committed daily totals the digest trend and health-check read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const audit = require('../../scripts/lib/rebuild-exclusion-audit.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-excl-audit-'));
}

describe('summarizeShowExclusionsForPrompt (BRO-3508)', () => {
  test('groups by reason, most frequent first, with capped examples', () => {
    const dir = tmpDir();
    fs.writeFileSync(audit.showExclusionsPath('hamlet-2026', dir), JSON.stringify({
      showId: 'hamlet-2026',
      exclusions: [
        { reason: 'skippedWrongProduction', file: 'a.json' },
        { reason: 'skippedWrongProduction', file: 'b.json' },
        { reason: 'skippedWrongProduction', file: 'c.json' },
        { reason: 'skippedNoScore', file: 'd.json' },
      ],
    }));
    const out = audit.summarizeShowExclusionsForPrompt('hamlet-2026', { auditDir: dir });
    assert.equal(out, 'rebuild exclusion log: skippedWrongProduction×3 (e.g. a.json, b.json); skippedNoScore×1 (e.g. d.json)');
  });

  test('caps reasons and reports the remainder', () => {
    const dir = tmpDir();
    const exclusions = ['r1', 'r2', 'r3'].map(reason => ({ reason, file: `${reason}.json` }));
    fs.writeFileSync(audit.showExclusionsPath('x', dir), JSON.stringify({ exclusions }));
    const out = audit.summarizeShowExclusionsForPrompt('x', { auditDir: dir, maxReasons: 2 });
    assert.match(out, /\+1 more reason\(s\)$/);
  });

  test('missing or corrupt file yields empty string (prompt line unchanged)', () => {
    const dir = tmpDir();
    assert.equal(audit.summarizeShowExclusionsForPrompt('nope', { auditDir: dir }), '');
    fs.writeFileSync(audit.showExclusionsPath('bad', dir), '{not json');
    assert.equal(audit.summarizeShowExclusionsForPrompt('bad', { auditDir: dir }), '');
  });

  test('analyze-rebuild-drops.js wires the summary into its prompt lines', () => {
    const src = fs.readFileSync(new URL('../../scripts/analyze-rebuild-drops.js', import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/lib\/rebuild-exclusion-audit'\)/);
    assert.match(src, /summarizeShowExclusionsForPrompt\(r\.showId\)/);
  });
});

describe('daily exclusion totals (BRO-3598)', () => {
  test('buildExclusionTotals counts distinct files per reason and skips "-"', () => {
    const totals = audit.buildExclusionTotals({
      s1: { exclusions: [
        { reason: 'skippedNoScore', file: 'a.json' },
        { reason: 'skippedNoScore', file: 'a.json' },
        { reason: 'skippedNoScore', file: 'b.json' },
        { reason: 'skippedUpcomingShows', file: '-' },
      ] },
      s2: { exclusions: [{ reason: 'skippedNoScore', file: 'a.json' }] },
    });
    assert.equal(totals.skippedNoScore.files, 3);
    assert.equal(totals.skippedNoScore.shows, 2);
    assert.equal(totals.skippedUpcomingShows, undefined);
  });

  test('mergeDailyTotals keeps the latest run per day and prunes old days', () => {
    let doc = { days: {} };
    for (let d = 1; d <= 20; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      doc = audit.mergeDailyTotals(doc, day, { r: { files: d, shows: 1, topShows: [] } }, 15);
    }
    doc = audit.mergeDailyTotals(doc, '2026-09-20', { r: { files: 99, shows: 1, topShows: [] } }, 15);
    const days = Object.keys(doc.days).sort();
    assert.equal(days.length, 15);
    assert.equal(days[0], '2026-09-06');
    assert.equal(doc.days['2026-09-20'].r.files, 99);
  });

  test('write then read round-trips; unreadable file reads as empty', () => {
    const dir = tmpDir();
    assert.deepEqual(audit.readDailyTotals(dir), { days: {} });
    audit.writeDailyExclusionTotals(
      { s1: { exclusions: [{ reason: 'skippedNoScore', file: 'a.json' }] } },
      { auditDir: dir, now: new Date('2026-10-12T03:00:00Z') },
    );
    const doc = audit.readDailyTotals(dir);
    assert.equal(doc.days['2026-10-12'].skippedNoScore.files, 1);
    fs.writeFileSync(audit.dailyTotalsPath(dir), 'garbage');
    assert.deepEqual(audit.readDailyTotals(dir), { days: {} });
  });
});

describe('computeTrendFromDailyTotals (BRO-3598)', () => {
  const { computeTrendFromDailyTotals } = require('../../scripts/lib/exclusion-trend.js');
  const row = (files) => ({ skippedNoScore: { files, shows: 1, topShows: {} } });
  const doc = { days: {} };
  for (let d = 1; d <= 7; d++) doc.days[`2026-10-0${d}`] = row(10);
  doc.days['2026-10-08'] = row(40);

  test('flags a jump on the latest day', () => {
    const t = computeTrendFromDailyTotals(doc, new Date('2026-10-08T12:00:00Z'));
    assert.equal(t.day, '2026-10-08');
    assert.equal(t.spikes.length, 1);
  });

  test('a latest day more than 2 days old reads as stale, never as today', () => {
    const t = computeTrendFromDailyTotals(doc, new Date('2026-10-11T12:00:00Z'));
    assert.equal(t.stale, true);
    assert.deepEqual(t.spikes, []);
    assert.equal(t.todayTotal, 0);
  });
});
