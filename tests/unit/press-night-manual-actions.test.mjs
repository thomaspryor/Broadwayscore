// BRO-6661: hand fixes auto-logged from review-texts commits (AFGM 2026-10-29, TheWrap hand ingest d2aad044 at 04:45Z).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = require(path.join(ROOT, 'scripts/lib/press-night-manual-actions.js'));
const lib = require(path.join(ROOT, 'scripts/lib/press-night-record.js'));

const SHOW = 'a-few-good-men-2026';
const rec = () => ({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/press-night', `${SHOW}-2026-10-29.json`), 'utf8')), manualActions: [] });
const S = M.SEP;
const RAW = [
  `${S}d2aad044aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|2026-10-30T04:45:00Z|github-actions[bot]|noreply@github.com|ingest-urls: a-few-good-men-2026 (1 URL)`,
  `${SHOW}/thewrap--robert-hofler.json`,
  '',
  `${S}bbbbbbbb11111111111111111111111111111111|2026-10-30T03:10:00Z|github-actions[bot]|noreply@github.com|data: scrape reviews`,
  `${SHOW}/nytimes--jesse-green.json`,
  '',
  `${S}cccccccc22222222222222222222222222222222|2026-10-30T02:30:00Z|Thomas Pryor|t@example.com|fix: clear wrongShow flag`,
  `${SHOW}/variety--frank-rizzo.json`,
  '',
  `${S}dddddddd33333333333333333333333333333333|2026-10-20T02:30:00Z|Thomas Pryor|t@example.com|old unrelated edit`,
  `${SHOW}/ew--dalton-ross.json`,
  '',
].join('\n');

test('parseGitLog reads sha, time, author, subject and files', () => {
  const c = M.parseGitLog(RAW);
  assert.equal(c.length, 4);
  assert.deepEqual(c[0].files, [`${SHOW}/thewrap--robert-hofler.json`]);
  assert.equal(c[0].subject, 'ingest-urls: a-few-good-men-2026 (1 URL)');
});

test('ingest-urls commit at 04:45Z for thewrap yields one manualActions entry for AFGM 10-29', () => {
  const r = rec();
  const found = M.manualActionsFromCommits(M.parseGitLog(RAW), { showId: SHOW, embargoAt: r.embargoAt });
  const ingest = found.filter((a) => a.outletId === 'thewrap');
  assert.equal(ingest.length, 1);
  assert.equal(ingest[0].at, '2026-10-30T04:45:00.000Z');
  assert.equal(ingest[0].kind, 'hand-fix');
  assert.match(ingest[0].source, /^d2aad044 ingest-urls:/);
  for (const a of found) lib.addManualAction(r, a);
  assert.equal(r.manualActions.filter((m) => m.outletId === 'thewrap').length, 1);
  // Re-running adds nothing (idempotent).
  for (const a of found) assert.equal(lib.addManualAction(r, a).added, false);
});

test('bot scrape commits and commits outside the night window are not hand fixes; human commit is', () => {
  const r = rec();
  const found = M.manualActionsFromCommits(M.parseGitLog(RAW), { showId: SHOW, embargoAt: r.embargoAt });
  assert.deepEqual(found.map((a) => a.outletId).sort(), ['thewrap', 'variety']);
});

test('a commit touching only other shows, or a bad embargo, logs nothing', () => {
  const other = `${S}eeeeeeee44444444444444444444444444444444|2026-10-30T04:45:00Z|Thomas Pryor|t@example.com|ingest-urls: x\nother-show-2026/thewrap--a.json\n`;
  assert.deepEqual(M.manualActionsFromCommits(M.parseGitLog(other), { showId: SHOW, embargoAt: rec().embargoAt }), []);
  assert.deepEqual(M.manualActionsFromCommits(M.parseGitLog(RAW), { showId: SHOW, embargoAt: 'nope' }), []);
});

test('outletIdFromFile', () => {
  assert.equal(M.outletIdFromFile(`${SHOW}/av-club--drew-gillis.json`, SHOW), 'av-club');
  assert.equal(M.outletIdFromFile(`${SHOW}/README.md`, SHOW), null);
});

test('alreadyLogged: a human entry for the same outlet 3 min earlier suppresses the auto entry', () => {
  const r = rec();
  r.manualActions = [{ at: '2026-10-30T04:42:00.000Z', outletId: 'thewrap', outlet: 'TheWrap', kind: 'hand-fix', source: 'BRO-5955 comment' }];
  const found = M.manualActionsFromCommits(M.parseGitLog(RAW), { showId: SHOW, embargoAt: r.embargoAt });
  assert.deepEqual(found.filter((a) => !M.alreadyLogged(r, a)).map((a) => a.outletId), ['variety']);
});

test('"GitHub Action" CI author (action@github.com) is a bot; multi-outlet ingest logs every outlet', () => {
  const ci = `${S}ffffffff55555555555555555555555555555555|2026-10-30T04:50:00Z|GitHub Action|action@github.com|data: LLM ensemble scoring\n${SHOW}/nytimes--jesse-green.json\n`;
  const multi = `${S}99999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|2026-10-30T04:55:00Z|Thomas Pryor|t@example.com|ingest-urls: 3 review(s) for ${SHOW}\n${SHOW}/a--x.json\n${SHOW}/b--y.json\n${SHOW}/c--z.json\n`;
  const r = rec();
  const found = M.manualActionsFromCommits(M.parseGitLog(ci + multi), { showId: SHOW, embargoAt: r.embargoAt });
  assert.deepEqual(found.map((a) => a.outletId).sort(), ['a', 'b', 'c']);
  let added = 0;
  for (const a of found) if (!M.alreadyLogged(r, a) && lib.addManualAction(r, a).added) added++;
  assert.equal(added, 3);
});
