// Guard L (BRO-5499): a NEW review whose text names two cast members of a same-title
// sibling production in the same market and none of this production's people is stamped
// wrongProduction at write time, even with an Unknown critic and no date (the shape that
// let a 2019 Gyllenhaal review sit on the 2026 Sea Wall entry, scored 88).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

// Real pair in shows.json: the 2004 Broadway King Lear and the 2019 one (Glenda Jackson).
const SHOW = 'king-lear-2004';
const body = (names) => `${names} fill the stage in this staging, and the evening runs long. `.repeat(12);

function write(dir, text, extra = {}) {
  return createOrMergeReviewFile(SHOW, {
    outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/king-lear-test-' + Math.random().toString(36).slice(2),
    source: 'submit-review-form', fields: { fullText: text, ...extra },
  }, { reviewTextsDir: dir });
}
function read(dir) {
  const d = path.join(dir, SHOW);
  const f = fs.readdirSync(d)[0];
  return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
}

test('stamps wrongProduction when the text names only the sibling production\'s cast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-cast-'));
  try {
    write(dir, body('Glenda Jackson and Pedro Pascal'));
    const d = read(dir);
    assert.equal(d.wrongProduction, true);
    assert.match(d.wrongProductionReason, /king-lear-2019/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('does not stamp a review that names no sibling cast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-cast-'));
  try {
    write(dir, body('The company and the lighting'));
    assert.notEqual(read(dir).wrongProduction, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('does not stamp a merge into a file that is already scored (BRO-5499 review)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-cast-'));
  try {
    const url = 'https://www.thestage.co.uk/reviews/king-lear-test-merge';
    const base = { outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown', url, source: 'submit-review-form' };
    createOrMergeReviewFile(SHOW, { ...base, fields: { fullText: body('The company and the lighting') } }, { reviewTextsDir: dir });
    const d = path.join(dir, SHOW);
    const f = path.join(d, fs.readdirSync(d)[0]);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    rec.assignedScore = 79;
    fs.writeFileSync(f, JSON.stringify(rec));
    createOrMergeReviewFile(SHOW, { ...base, fields: { fullText: body('Glenda Jackson and Pedro Pascal') } }, { reviewTextsDir: dir });
    assert.notEqual(read(dir).wrongProduction, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
