// BRO-4427: a temporal-override CV.wrongProduction=true row whose own text names
// the show is a warning; everything else stays the blocking error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const check = require('./opening-night-checks/cv-wrongproduction-unhandled.check.js');

const SHOW = { id: 'the-school-girls', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-10-01', category: 'broadway' };
const OVERRIDE = '[OVERRIDE: review within 2d of opening, likely correct production] Review published near opening.';
const LEDE = 'School Girls; Or, The African Mean Girls Play opens at the Studio 54 with a sharp new cast. '.repeat(2);

function run(file, { show = SHOW, ctx = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4427-'));
  try {
    fs.mkdirSync(path.join(root, show.id));
    const base = { url: 'https://ex.com/a', outletId: 'nysr', criticName: 'A Critic', publishDate: '2026-10-03' };
    fs.writeFileSync(path.join(root, show.id, 'r.json'), JSON.stringify({ ...base, ...file }));
    const reviewsDoc = { [show.id]: [{ url: base.url, outletId: base.outletId, criticName: base.criticName }] };
    return check.run(show, { reviewTextsRoot: root, reviewsDoc, ...ctx });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const cv = (over = {}) => ({ wrongProduction: true, confidence: 'low', reasoning: OVERRIDE, issues: [], ...over });

test('override + title named in lede => warning, not error', () => {
  const r = run({ fullText: LEDE + 'x'.repeat(200), contentVerification: cv() });
  assert.equal(r.severity, 'warning');
  assert.equal(r.details.warnings.length, 1);
});

test('override but text never names the show => stays error', () => {
  assert.equal(run({ fullText: 'A review of something else entirely. '.repeat(10), contentVerification: cv() }).severity, 'error');
});

test('title only past the first 1500 chars (roundup) => stays error', () => {
  const r = run({ fullText: 'Unrelated roundup text. '.repeat(100) + LEDE, contentVerification: cv() });
  assert.equal(r.severity, 'error');
});

test('a single title word is not a mention', () => {
  assert.equal(run({ fullText: 'The African queen sails again. '.repeat(5), contentVerification: cv() }).severity, 'error');
});

test('CV issues naming a different show => stays error', () => {
  const r = run({ fullText: LEDE, contentVerification: cv({ issues: ['Article is about Hamilton, a different show'], reasoning: OVERRIDE + ' Article is about a different show.' }) });
  assert.equal(r.severity, 'error');
});

test('publishDate outside the 30-day window => stays error', () => {
  assert.equal(run({ fullText: LEDE, publishDate: '2026-12-15', contentVerification: cv() }).severity, 'error');
});

test('non-override low confidence, high confidence => stays error', () => {
  assert.equal(run({ fullText: LEDE, contentVerification: cv({ reasoning: 'Wrong production.' }) }).severity, 'error');
  assert.equal(run({ fullText: LEDE, contentVerification: cv({ confidence: 'high' }) }).severity, 'error');
});

test('same title, different staging wording => stays error', () => {
  for (const reasoning of ['Reviews the London staging at the Lyric Hammersmith.', 'Describes the national tour stop in Chicago.', 'Different cast listed.', 'This is the 2019 revival.']) {
    assert.equal(run({ fullText: LEDE, contentVerification: cv({ reasoning: `[OVERRIDE: review within 2d of opening, likely correct production] ${reasoning}` }) }).severity, 'error', reasoning);
  }
});

test('one-word title is never corroborated', () => {
  const show = { id: 'six', title: 'Six', openingDate: '2026-10-01', category: 'broadway' };
  assert.equal(run({ fullText: 'Six is a pop concert. '.repeat(5), contentVerification: cv() }, { show }).severity, 'error');
});

test('sweep mode (setAsideHandled) still counts the warning', () => {
  const r = run({ fullText: LEDE, contentVerification: cv() }, { ctx: { setAsideHandled: true } });
  assert.equal(r.severity, 'warning');
  assert.equal(r.details.warnings.length, 1);
});

test('a one-word slug variant of a multi-word title is not a mention', () => {
  const show = { id: 'cabaret-2024', title: 'Cabaret at the Kit Kat Club', openingDate: '2026-10-01', category: 'broadway' };
  assert.equal(run({ fullText: 'Cabaret is back and louder than ever. '.repeat(5), contentVerification: cv() }, { show }).severity, 'error');
  assert.equal(run({ fullText: 'Cabaret at the Kit Kat Club is back and louder than ever. '.repeat(3), contentVerification: cv() }, { show }).severity, 'warning');
});
