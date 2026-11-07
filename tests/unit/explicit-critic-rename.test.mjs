/**
 * BRO-5166: ingest-review-from-url.js --critic onto an --unknown file (a TB
 * forum-thread husk upgraded to its review page) always failed "Stale merge:
 * criticName" because the writer never merges criticName. The real
 * applyExplicitCriticToUnknown now names it through the guarded rename.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyExplicitCriticToUnknown } = require('../../scripts/lib/explicit-critic-rename');

const SHOW = 'explicit-critic-show';
const URL = 'https://www.talkinbroadway.com/page/ob/09_25_26.html';
function husk(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5166-critic-'));
  const showDir = path.join(dir, SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, 'talkinbroadway--unknown.json');
  const data = { showId: SHOW, outletId: 'talkinbroadway', outlet: "Talkin' Broadway", criticName: 'Unknown', url: URL, contentTier: 'complete', fullText: 'Body. '.repeat(200) };
  fs.writeFileSync(fp, JSON.stringify(data));
  return { dir, showDir, fp, data, ...extra };
}

test('names an --unknown file and renames it to the critic slug', () => {
  const { dir, showDir, fp, data } = husk();
  const r = applyExplicitCriticToUnknown(fp, data, { showId: SHOW, criticName: 'Moshe A. Bloxenheim', url: URL });
  assert.equal(r.applied, true);
  assert.equal(path.basename(r.newPath), 'talkinbroadway--moshe-a-bloxenheim.json');
  assert.equal(fs.existsSync(fp), false);
  assert.equal(JSON.parse(fs.readFileSync(r.newPath, 'utf8')).criticName, 'Moshe A. Bloxenheim');
  assert.deepEqual(fs.readdirSync(showDir), ['talkinbroadway--moshe-a-bloxenheim.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses when a same-outlet sibling already holds that critic (file untouched)', () => {
  const { dir, showDir, fp, data } = husk();
  fs.writeFileSync(path.join(showDir, 'talkinbroadway--moshe-a-bloxenheim.json'),
    JSON.stringify({ ...data, criticName: 'Moshe A. Bloxenheim', url: 'https://www.talkinbroadway.com/page/ob/other.html' }));
  const r = applyExplicitCriticToUnknown(fp, data, { showId: SHOW, criticName: 'Moshe A. Bloxenheim', url: URL });
  assert.equal(r.applied, false);
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).criticName, 'Unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('never touches a named file, a non-name, or a missing critic', () => {
  const { dir, fp, data } = husk();
  assert.equal(applyExplicitCriticToUnknown(fp, { ...data, criticName: 'Jane Doe' }, { showId: SHOW, criticName: 'Moshe A. Bloxenheim' }).reason, 'already-named');
  assert.equal(applyExplicitCriticToUnknown(fp, data, { showId: SHOW, criticName: "Talkin' Broadway", url: URL }).applied, false);
  assert.equal(applyExplicitCriticToUnknown(fp, data, { showId: SHOW, criticName: null }).reason, 'not-unknown-file');
  assert.equal(applyExplicitCriticToUnknown(fp.replace('--unknown', '--jane-doe'), data, { showId: SHOW, criticName: 'Moshe A. Bloxenheim' }).reason, 'not-unknown-file');
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).criticName, 'Unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses when the writer kept the old url (body belongs to another page)', () => {
  const { dir, fp, data } = husk();
  const forum = { ...data, url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2653913' };
  fs.writeFileSync(fp, JSON.stringify(forum));
  const r = applyExplicitCriticToUnknown(fp, forum, { showId: SHOW, criticName: 'Moshe A. Bloxenheim', url: URL });
  assert.deepEqual(r, { applied: false, reason: 'url-not-landed' });
  assert.equal(fs.existsSync(fp), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
