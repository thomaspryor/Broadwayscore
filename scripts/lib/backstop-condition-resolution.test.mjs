// BRO-4457: the ">24h T1/T2 review stuck" backstop card for a known-syndication
// SECONDARY (nydailynews Chris Jones, whose chicagotribune primary is scored)
// never closed. The scorer skips the secondary on purpose (explainExclusion ->
// 'knownSyndicationSecondary'), classifySilentGap stopped reporting it, but
// classifyGapCardState returned null, so audit-t1-silent-gaps.js's
// closeCardIfTerminal never called resolveCondition() on the open card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap, classifyGapCardState, GAP_CARD_STATE } = require('./t1-silent-gap.js');
const { explainExclusion, isIncludableForRebuild } = require('./review-guards.js');

const NOW = new Date('2026-10-14T12:00:00Z');
const BODY = Array.from({ length: 60 }, (_, i) =>
  `Paragraph ${i}: the director shapes scene ${i} with a different comic rhythm and the ensemble answers each beat.`).join(' ');

function fixture({ primaryOverrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4457-'));
  const secondary = {
    showId: 'school-girls-or-the-african-mean-girls-play-2026', outletId: 'nydailynews', outlet: 'New York Daily News',
    criticName: 'Chris Jones', source: 'dtli', sources: ['dtli', 'dtli-domain-supplement'],
    url: 'https://www.nydailynews.com/2026/09/28/school-girls-african-mean-girls-play-review-broadway/',
    fullText: BODY, isFullReview: true, contentTier: 'complete', textStatus: 'complete', textQuality: 'full',
    contentVerification: { isValid: true, confidence: 'high', truncated: false, wrongArticle: false, wrongProduction: false },
    llmScore: null, ensembleData: null, assignedScore: null,
    firstSeenAt: '2026-09-29T06:59:42.774Z', textFetchedAt: '2026-09-29T07:01:15.894Z',
  };
  const secPath = path.join(dir, 'nydailynews--chris-jones.json');
  fs.writeFileSync(secPath, JSON.stringify(secondary));
  if (primaryOverrides !== null) {
    const primary = {
      ...secondary, outletId: 'chicagotribune', outlet: 'Chicago Tribune', source: 'outlet-serp-discovery',
      url: 'https://www.chicagotribune.com/2026/09/28/review-school-girls-african-mean-girls-broadway/',
      llmScore: { score: 90, confidence: 'high' }, assignedScore: 90, scoreSource: 'llm-v6',
      ...(primaryOverrides || {}),
    };
    fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify(primary));
  }
  const args = { file: secondary, show: {}, tier: 1, outletScored: false, now: NOW, filePath: secPath };
  return { dir, secondary, secPath, args };
}

test('eligibility rule: syndicated secondary is excluded from scoring when a live primary exists', () => {
  const { secondary, secPath, dir } = fixture();
  assert.equal(explainExclusion(secondary, {}, secPath, { forScoring: true }), 'knownSyndicationSecondary');
  assert.equal(isIncludableForRebuild(secondary, {}, secPath, { forScoring: true }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('eligibility rule: no primary on disk -> secondary stays scoreable', () => {
  const { secondary, secPath, dir } = fixture({ primaryOverrides: null });
  assert.equal(explainExclusion(secondary, {}, secPath, { forScoring: true }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backstop card for a shielded syndicated secondary resolves as COLLECTED', () => {
  const { args, dir } = fixture();
  assert.equal(classifySilentGap(args), null, 'not a gap');
  assert.equal(classifyGapCardState(args), GAP_CARD_STATE.COLLECTED, 'open card must close');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a primary that will not be scored does not shield the secondary: card stays OPEN', () => {
  const { args, dir } = fixture({ primaryOverrides: { wrongShow: true } });
  assert.equal(classifySilentGap(args)?.type, 'unscored');
  assert.equal(classifyGapCardState(args), GAP_CARD_STATE.OPEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no primary on disk: unscored secondary is a real open gap', () => {
  const { args, dir } = fixture({ primaryOverrides: null });
  assert.equal(classifyGapCardState(args), GAP_CARD_STATE.OPEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without filePath the card state is never claimed COLLECTED from sibling logic', () => {
  const { args, dir } = fixture();
  const { filePath, ...noPath } = args;
  assert.equal(classifyGapCardState(noPath), GAP_CARD_STATE.OPEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [label, overrides] of [
  ['isRoundupArticle', { isRoundupArticle: true }],
  ['fabricatedEntry', { fabricatedEntry: true }],
  ['wrongAttribution', { wrongAttribution: true }],
  ['no valid score yet', { llmScore: null, assignedScore: null, scoreSource: null }],
]) {
  test(`primary with ${label} does not close the secondary's card as COLLECTED`, () => {
    const { args, dir } = fixture({ primaryOverrides: overrides });
    assert.notEqual(classifyGapCardState(args), GAP_CARD_STATE.COLLECTED);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
