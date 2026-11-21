import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifySplitSection, danglingLead, firstSentence, scanReviewTexts } = require('./split-section-audit.js');

const LEAD = 'Though it is similarly portable, I would not recommend that approach for the other production on the block. The rest of the section is about the show itself.';

test('back-reference leads are caught, standalone openings are not', () => {
  assert.equal(danglingLead(LEAD).danglingLead, true);
  assert.equal(danglingLead('But the second act drags. Then it recovers.').danglingLead, true);
  assert.equal(danglingLead('Unlike the first show on the bill, this one never settles.').danglingLead, true);
  assert.equal(danglingLead('The lead delivers a performance of startling control. The band is superb.').danglingLead, false);
  assert.equal(danglingLead('"Sample Show" is an odd, cool hour. It suits some audiences.').danglingLead, false);
  assert.equal(firstSentence('One. Two.'), 'One.');
});

const twoGirlsShape = (over = {}) => ({
  showId: 'sample-off-broadway-2026',
  multiShowSplitChild: true,
  fullText: LEAD,
  assignedScore: 46,
  ensembleData: { claudeScore: 62, openaiScore: 40, geminiScore: 40, kimiScore: null },
  ...over,
});

test('the BRO-6000 shape is a suspect: back-reference lead, Claude 22 above the other legs, score below Claude', () => {
  const c = classifySplitSection(twoGirlsShape());
  assert.equal(c.suspect, true);
  assert.equal(c.claudeLead, 22);
  assert.equal(c.danglingLead, true);
  assert.equal(c.why.length, 2);
});

test('a high score, a whole review, an unscored file and a unanimous ensemble are not suspects', () => {
  assert.equal(classifySplitSection(twoGirlsShape({ assignedScore: 78, ensembleData: { claudeScore: 78, openaiScore: 79, geminiScore: 77 } })).suspect, false);
  assert.equal(classifySplitSection({ ...twoGirlsShape(), multiShowSplitChild: undefined }), null);
  assert.equal(classifySplitSection(twoGirlsShape({ assignedScore: undefined, llmScore: undefined })), null);
  const calm = classifySplitSection(twoGirlsShape({ fullText: 'The lead is superb. The band is tight.', assignedScore: 60, ensembleData: { claudeScore: 61, openaiScore: 60, geminiScore: 59 } }));
  assert.equal(calm.suspect, false);
});

test('Claude-lead alone flags only when the published score fell below Claude', () => {
  const c = classifySplitSection(twoGirlsShape({ fullText: 'The lead is superb.', assignedScore: 66, ensembleData: { claudeScore: 62, openaiScore: 40, geminiScore: 40 } }));
  assert.equal(c.suspect, false, 'score above Claude is not the failure');
  const d = classifySplitSection(twoGirlsShape({ fullText: 'The lead is superb.', assignedScore: 46 }));
  assert.equal(d.suspect, true);
});

test('the scan lists the suspect from a fixture folder and skips flagged duplicates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-audit-'));
  const dir = path.join(root, 'sample-off-broadway-2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nytimes--critic.json'), JSON.stringify(twoGirlsShape({ outletId: 'nytimes' })));
  fs.writeFileSync(path.join(dir, 'nytimes--dup.json'), JSON.stringify(twoGirlsShape({ duplicateOf: 'nytimes--critic.json' })));
  fs.writeFileSync(path.join(dir, 'theatermania--x.json'), JSON.stringify({ showId: 'sample-off-broadway-2026', fullText: 'A whole review.', assignedScore: 40 }));
  const out = scanReviewTexts(root);
  assert.equal(out.sections, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].file, 'sample-off-broadway-2026/nytimes--critic.json');
  assert.equal(out.rows[0].suspect, true);
});
