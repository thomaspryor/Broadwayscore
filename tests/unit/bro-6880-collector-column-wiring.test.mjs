// BRO-6880 v2: the collector cuts a Washington Post multi-show column down to this show's section ONLY after the
// content verifier rejects the whole page as multi-show, re-verifies the section, and hands the section to the save
// path. A page the verifier accepts is stored as fetched. The verifier is stubbed (no LLM call); synthetic prose only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cv = require('../../scripts/lib/content-verifier.js');
const calls = [];
let acceptWhole = false;
// Rejects any text that still covers the other shows; accepts a single-show text.
cv.verifyContent = async ({ scrapedText }) => {
  calls.push(scrapedText);
  const multi = /Other Desert Cities/.test(scrapedText) && /School Girls/.test(scrapedText);
  if (multi && !acceptWhole) {
    return { isValid: false, confidence: 'high', issues: ['Multi-show roundup reviewing three different productions'], reasoning: 'Covers three shows.', verifiedBy: 'llm:stub' };
  }
  return { isValid: true, confidence: 'high', issues: [], reasoning: 'A review of the show.', verifiedBy: 'llm:stub' };
};
const { verifyFetchedContent } = require('../../scripts/collect-review-texts.js');

const URL = 'https://www.washingtonpost.com/entertainment/theater/2026/10/23/stars-are-shining-broadway-an-upstart-musical-upstages-them-all/';
const filler = (tag, n = 5) => Array.from({ length: n }, (_, i) => `The ${tag} cast keeps a steady pace through scene ${i + 1} and the staging stays clear.`).join(' ');
const ODC = `‘Other Desert Cities’ returns with a family fight over a memoir. ${filler('ODC')} ‘Other Desert Cities’ still has bite.\n\nThe second act of the ODC revival lands the reveal cleanly. ${filler('ODC-two')}`;
const SG = `Over at another house, ‘School Girls; Or, The African Mean Girls Play’ follows a clique in Ghana. ${filler('SG')} Seeing ‘School Girls; Or, The African Mean Girls Play’ again is a pleasure.\n\nThe ensemble of the SG production shares one voice. ${filler('SG-two')}`;
const TII = `Best of the three is ‘The Imaginary Invalid,’ a farce about a man sure he is dying. ${filler('TII')} ‘The Imaginary Invalid’ is the one to see.\n\nIts closing scene earns the loudest laugh of the column. ${filler('TII-two')}`;
const COLUMN = `Three openings this week, and one clear winner.\n\n${ODC}\n\n${SG}\n\n${TII}`;
const SHOWS = [
  { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway', openingDate: '2026-10-22' },
  { id: 'other-desert-cities-2026', title: 'Other Desert Cities', category: 'broadway', openingDate: '2026-10-18' },
  { id: 'school-girls-2026', title: 'School Girls; Or, The African Mean Girls Play', category: 'broadway', openingDate: '2026-10-20' },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6880-wiring-'));
fs.mkdirSync(path.join(dir, 'data'));
fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({ shows: SHOWS }));
const filePath = path.join(dir, 'washpost--thomas-floyd.json');
fs.writeFileSync(filePath, JSON.stringify({ showId: 'the-imaginary-invalid-2026', url: URL, outlet: 'The Washington Post', criticName: 'Thomas Floyd' }));
process.chdir(dir); // the collector reads data/shows.json relative to cwd
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const review = { filePath, showId: 'the-imaginary-invalid-2026', url: URL, outlet: 'The Washington Post', critic: 'Thomas Floyd' };

test('a column rejected as multi-show is re-verified as this show\'s section, and the section replaces the text', async () => {
  calls.length = 0; acceptWhole = false;
  const result = { text: COLUMN, html: '' };
  const validation = { wordCount: 400, valid: true, issues: [] };
  const verdict = await verifyFetchedContent(review, result, validation);
  assert.equal(calls.length, 2, 'whole page, then the section');
  assert.equal(verdict.isValid, true);
  assert.equal(verdict.columnSectionIsolated, true);
  assert.match(result.text, /closing scene earns the loudest laugh/);
  assert.doesNotMatch(result.text, /Other Desert Cities|School Girls|Three openings/);
  assert.ok(validation.wordCount < 400, 'validation recomputed for the section');
});

test('a page the verifier accepts is never cut', async () => {
  calls.length = 0; acceptWhole = true;
  const result = { text: COLUMN, html: '' };
  const verdict = await verifyFetchedContent(review, result, { wordCount: 400, valid: true, issues: [] });
  assert.equal(calls.length, 1);
  assert.equal(verdict.isValid, true);
  assert.equal(verdict.columnSectionIsolated, undefined);
  assert.equal(result.text, COLUMN);
});
