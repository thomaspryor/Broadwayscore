import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { seasonsWithData } = require('./lib/biz-og-cards');
const { auditBizOgCoverage, checkBizOgCoverage, CHECK_NAME, RENDER_HINT } = require('./lib/audit-biz-og-coverage');
const { computeCoreHealthResults, getPlaybookEntry } = require('./health-check.js');

function withRepo(shows, commercial, cards, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-og-coverage-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const ogDir = path.join(root, 'public', 'og', 'biz');
    fs.mkdirSync(ogDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify(shows));
    fs.writeFileSync(path.join(root, 'data', 'commercial.json'), JSON.stringify(commercial));
    for (const name of cards) fs.writeFileSync(path.join(ogDir, name), 'png fixture');
    return fn(root, ogDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const shows = [
  { slug: 'spring', openingDate: '2027-06-30', season: 'wrong-season' },
  { slug: 'summer', openingDate: '2027-07-01', season: '2026-2027' },
  { slug: 'summer-peer', openingDate: '2027-08-10' },
  { slug: 'no-commercial', openingDate: '2030-07-01' },
  { slug: 'no-opening-date' },
];
const commercial = { shows: { spring: {}, summer: {}, 'summer-peer': {}, 'no-opening-date': {}, orphan: {} } };

for (const raw of [shows, { shows }]) {
  test(`season discovery uses opening dates, deduplicates and ignores unmatched records (${Array.isArray(raw) ? 'array' : 'object'})`, () => {
    assert.deepEqual(seasonsWithData(raw, commercial), ['2026-2027', '2027-2028']);
  });
}

test('July 2027 commercial activity flags its missing custom card despite the generic fallback', () => {
  withRepo({ shows }, commercial, ['season.png', 'season-2026-2027.png', 'season-2030-2031.png'], root => {
    assert.deepEqual(auditBizOgCoverage(root), { seasons: ['2026-2027', '2027-2028'], missing: ['2027-2028'] });
    const row = checkBizOgCoverage(root);
    assert.equal(row.name, CHECK_NAME);
    assert.equal(row.status, 'warn');
    assert.match(row.message, /1\/2 commercial seasons: season-2027-2028\.png/);
    assert.equal(row.hint, RENDER_HINT);
  });
});

test('adding the missing custom card clears the advisory', () => {
  withRepo(shows, commercial, ['season-2026-2027.png'], (root, ogDir) => {
    assert.deepEqual(auditBizOgCoverage(root).missing, ['2027-2028']);
    fs.writeFileSync(path.join(ogDir, 'season-2027-2028.png'), 'png fixture');
    assert.deepEqual(auditBizOgCoverage(root).missing, []);
    assert.equal(checkBizOgCoverage(root).status, 'pass');
  });
});

test('missing output directory lists all commercial seasons; directories named .png do not count', () => {
  withRepo(shows, commercial, [], (root, ogDir) => {
    fs.mkdirSync(path.join(ogDir, 'season-2026-2027.png'));
    assert.deepEqual(auditBizOgCoverage(root).missing, ['2026-2027', '2027-2028']);
    fs.rmSync(ogDir, { recursive: true });
    assert.deepEqual(auditBizOgCoverage(root).missing, ['2026-2027', '2027-2028']);
  });
});

test('no commercial activity requires no season cards', () => {
  withRepo(shows, { shows: {} }, [], root => {
    assert.deepEqual(auditBizOgCoverage(root), { seasons: [], missing: [] });
    assert.equal(checkBizOgCoverage(root).status, 'pass');
  });
});

test('missing, malformed, or invalid-date inputs warn without blocking the daily health check', () => {
  withRepo(shows, commercial, [], root => {
    const file = path.join(root, 'data', 'shows.json');
    for (const contents of ['{', '{}', JSON.stringify([{ slug: 'summer', openingDate: 'invalid' }])]) {
      fs.writeFileSync(file, contents);
      const row = checkBizOgCoverage(root);
      assert.equal(row.status, 'warn');
      assert.match(row.message, /Could not audit/);
    }
    fs.rmSync(file);
    assert.equal(checkBizOgCoverage(root).status, 'warn');
  });
});

test('daily core health check includes the advisory and routes persistent gaps to an actionable alert', () => {
  assert.match(String(computeCoreHealthResults), /\bcheckBizOgCoverage\(\)/);
  const entry = getPlaybookEntry(CHECK_NAME);
  assert.equal(entry.urgency, 'this-week');
  assert.equal(entry.humanAction, RENDER_HINT);
  assert.equal(entry.workflow, undefined);
});

test('CLI help runs from an unrelated working directory without reading data', () => {
  const script = require.resolve('./lib/audit-biz-og-coverage');
  const help = spawnSync(process.execPath, [script, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node scripts\/lib\/audit-biz-og-coverage\.js/);
});
