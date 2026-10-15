// BRO-4606: a wrong-article verdict from the daily LLM pass must never sit
// unresolved. Every 'wrong-article' adjudication for a file's CURRENT text has
// to be either flagged wrongShow (it leaves the scores) or hand-verified as a
// false positive after reading it (data/audit/wrong-article-verified.json,
// via audit-wrong-article.js --verify-file). Otherwise the audit gate stays red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/audit-wrong-article.js');
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data/review-texts');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const require = createRequire(import.meta.url);
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards');
const { hashText } = require('../../scripts/audit-wrong-article.js');

const adjPath = path.join(ROOT, 'data/audit/wrong-article-adjudicated.json');
const verPath = path.join(ROOT, 'data/audit/wrong-article-verified.json');
const hasTexts = fs.existsSync(TEXTS) && fs.readdirSync(TEXTS).length > 100;

// Advisory first (CLAUDE.md §19, BRO-4521): the daily pass commits verdicts with no
// human step, so a blocking check would turn every PR red. `todo` reports failures
// without failing the run; drop it once the worker queue reliably clears these.
test('every confirmed wrong article is flagged wrongShow or hand-verified', { todo: 'advisory (BRO-4606)', skip: !hasTexts && 'review-texts not checked out' }, () => {
  const adjudicated = read(adjPath);
  const verified = read(verPath);
  const unresolved = [];
  for (const [file, entry] of Object.entries(adjudicated)) {
    if (entry.verdict !== 'wrong-article') continue;
    const fp = path.join(TEXTS, file);
    if (!fs.existsSync(fp)) continue;
    const j = read(fp);
    if (!j.fullText || hashText(j.fullText) !== entry.hash) continue; // text changed: re-asked next run
    let included = false;
    try { included = isIncludableForRebuild(j) === true; } catch { /* not includable */ }
    if (!included) continue; // already out of the scores by another flag
    if (j.wrongShow === true || verified[file] === entry.hash) continue;
    unresolved.push(file);
  }
  assert.deepEqual(unresolved, []);
});

test('--verify-file refuses a file that is not a current suspect and writes nothing', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const before = fs.readFileSync(verPath, 'utf8');
  const r = spawnSync('node', [SCRIPT, '--verify-file=no-such-show/nobody.json'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: empty }, encoding: 'utf8',
  });
  if (/ENOENT/.test(r.stderr)) return t.skip('core data not checked out');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not a current suspect/);
  assert.equal(fs.readFileSync(verPath, 'utf8'), before);
});
