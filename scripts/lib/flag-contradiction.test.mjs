import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectFlagContradiction,
  detectCvFlagContradiction,
  contradictionFixCommand,
  shouldAlertContradiction,
} = require('./flag-contradiction.js');

// Pre-fix Grace Pervades snapshot: a real West End review flagged
// wrongProduction:true by an early flagger (2026-04-15), then re-verified by a
// LATER contentVerification run (2026-06-06) that rules it a valid review of
// the RIGHT West End production. The stale flag still suppresses it — this is
// exactly the contradiction the detector must surface.
const GRACE_STALE_FLAG = {
  showId: 'grace-pervades-west-end-2026',
  outletId: 'financialtimes',
  criticName: 'Sarah Hemming',
  url: 'https://www.ft.com/content/grace-pervades-west-end',
  wrongProduction: true,
  wrongProductionFlaggedAt: '2026-04-15T19:50:55.444Z',
  contentVerification: {
    isValid: true,
    wrongProduction: false,
    wrongArticle: false,
    articleType: 'review',
    reasoning: 'Substantive review of Grace Pervades at Theatre Royal Haymarket (West End), published day after opening. Valid, right production.',
    verifiedBy: 'llm:claude-haiku',
    verifiedAt: '2026-06-06T06:04:00.397Z',
  },
};

test('Grace Pervades stale-flag snapshot triggers a contradiction', () => {
  const c = detectFlagContradiction(GRACE_STALE_FLAG);
  assert.ok(c, 'should detect a contradiction');
  assert.equal(c.flag, 'wrongProduction');
  assert.equal(c.flaggedAt, '2026-04-15T19:50:55.444Z');
  assert.equal(c.verifiedAt, '2026-06-06T06:04:00.397Z');
  assert.match(c.cvReasoning, /right production|Haymarket|West End/i);
});

test('manual-cleared file does NOT trigger (human ruling wins)', () => {
  const cleared = { ...GRACE_STALE_FLAG, wrongProductionManualClear: true };
  assert.equal(detectFlagContradiction(cleared), null);
});

test('humanReviewedWrongProduction:true (human confirmed wrong-prod) does NOT trigger', () => {
  const confirmed = { ...GRACE_STALE_FLAG, humanReviewedWrongProduction: true };
  assert.equal(detectFlagContradiction(confirmed), null);
});

test('humanReviewScore set does NOT trigger', () => {
  const scored = { ...GRACE_STALE_FLAG, humanReviewScore: 88 };
  assert.equal(detectFlagContradiction(scored), null);
});

test('wrongProductionOverride does NOT trigger', () => {
  const overridden = { ...GRACE_STALE_FLAG, wrongProductionOverride: true };
  assert.equal(detectFlagContradiction(overridden), null);
});

test('CV that AGREES with the flag (genuine Bath tryout) does NOT trigger', () => {
  // The real FT/Bath file: file flag AND CV both say wrongProduction:true. No
  // contradiction — the flag is correct.
  const bath = {
    ...GRACE_STALE_FLAG,
    contentVerification: {
      ...GRACE_STALE_FLAG.contentVerification,
      isValid: false,
      wrongProduction: true,
      reasoning: 'Reviews the Theatre Royal Bath tryout, not the West End production.',
    },
  };
  assert.equal(detectFlagContradiction(bath), null);
});

test('CV OLDER than the flag does NOT trigger (same-run / stale CV)', () => {
  // A CV that pre-dates the flag can't contradict it — it may be the very
  // verdict that led to the flag, or an older read the flagger superseded.
  const olderCv = {
    ...GRACE_STALE_FLAG,
    contentVerification: {
      ...GRACE_STALE_FLAG.contentVerification,
      verifiedAt: '2026-04-10T00:00:00.000Z', // before the 2026-04-15 flag
    },
  };
  assert.equal(detectFlagContradiction(olderCv), null);
});

test('flag with NO timestamp does NOT trigger (can not prove CV is newer)', () => {
  const noStamp = { ...GRACE_STALE_FLAG };
  delete noStamp.wrongProductionFlaggedAt;
  assert.equal(detectFlagContradiction(noStamp), null);
});

test('wrongShow is OUT OF SCOPE (no reliable flag-set timestamp) — does NOT fire', () => {
  // wrongShowFlaggedAt does not exist in the corpus, and generic flaggedAt is
  // written by unrelated flows, so the "newer than flag" test can't be trusted.
  const wrongShow = {
    showId: 'giant-2026',
    outletId: 'nytimes',
    wrongShow: true,
    flaggedAt: '2026-04-22T00:00:00.000Z', // generic — NOT trusted
    contentVerification: {
      isValid: true, wrongProduction: false, wrongArticle: false,
      articleType: 'review', reasoning: 'Valid Broadway review of Giant.',
      verifiedAt: '2026-05-01T00:00:00.000Z',
    },
  };
  assert.equal(detectFlagContradiction(wrongShow), null);
});

test('wrongProduction with ONLY generic flaggedAt (no wrongProductionFlaggedAt) does NOT fire', () => {
  // Guards the Codex finding: generic flaggedAt must not establish "newer".
  const genericOnly = {
    showId: 'x', outletId: 'nytimes', wrongProduction: true,
    flaggedAt: '2026-04-15T00:00:00.000Z', // generic, unrelated writer
    contentVerification: { isValid: true, wrongProduction: false, verifiedAt: '2026-06-06T00:00:00.000Z' },
  };
  assert.equal(detectFlagContradiction(genericOnly), null);
});

test('duplicateOf is out of scope (CV can not contradict duplication)', () => {
  const dup = {
    showId: 'grace-pervades-west-end-2026',
    duplicateOf: 'artsdesk--unknown.json',
    flaggedAt: '2026-04-15T00:00:00.000Z',
    contentVerification: {
      isValid: true, wrongProduction: false, wrongArticle: false,
      verifiedAt: '2026-06-06T00:00:00.000Z',
    },
  };
  assert.equal(detectFlagContradiction(dup), null);
});

test('no contentVerification → null', () => {
  assert.equal(detectFlagContradiction({ wrongProduction: true, wrongProductionFlaggedAt: '2026-04-15T00:00:00Z' }), null);
});

test('fix command names the file + points at the show-scoped clearer', () => {
  const cmd = contradictionFixCommand('grace-pervades-west-end-2026', 'financialtimes--sarah-hemming.json', 'wrongProduction');
  assert.match(cmd, /clear-stale-wrong-production-flags\.js/);
  assert.match(cmd, /--show=grace-pervades-west-end-2026/);
  assert.match(cmd, /financialtimes--sarah-hemming\.json/);
});

test('dedupe: re-alert only after the window', () => {
  const now = new Date('2026-07-22T12:00:00Z');
  assert.equal(shouldAlertContradiction(null, now), true);
  assert.equal(shouldAlertContradiction('2026-07-22T00:00:00Z', now), false); // <7d
  assert.equal(shouldAlertContradiction('2026-07-10T00:00:00Z', now), true);  // >7d
  assert.equal(shouldAlertContradiction('garbage', now), true);               // unparseable → alert
});

// --- detectCvFlagContradiction (#651) — timestamp-free, broader flag coverage ---

test('JCS case: isRoundupArticle flag + high-confidence affirming CV → contradiction', () => {
  const jcs = {
    isRoundupArticle: true,
    textWordCount: 821,
    contentVerification: { isValid: true, confidence: 'high', reasoning: 'Reviews the current West End staging.' },
  };
  const result = detectCvFlagContradiction(jcs);
  assert.equal(result.contradicted, true);
  assert.equal(result.flag, 'isRoundupArticle');
});

test('Heathers case: wrongProduction flag + high-confidence affirming CV → contradiction', () => {
  const heathers = {
    wrongProduction: true,
    textWordCount: 1092,
    contentVerification: { isValid: true, confidence: 'high', reasoning: 'Confirms the Off-West End run.' },
  };
  const result = detectCvFlagContradiction(heathers);
  assert.equal(result.contradicted, true);
  assert.equal(result.flag, 'wrongProduction');
});

test('wrongShow flag also covered (unlike detectFlagContradiction, which excludes it)', () => {
  const f = {
    wrongShow: true,
    wordCount: 500,
    contentVerification: { isValid: true, confidence: 'high' },
  };
  assert.equal(detectCvFlagContradiction(f).flag, 'wrongShow');
});

test('falls back to wordCount when textWordCount is absent', () => {
  const f = {
    wrongProduction: true,
    wordCount: 400,
    contentVerification: { isValid: true, confidence: 'high' },
  };
  assert.ok(detectCvFlagContradiction(f));
});

test('no flag set → null', () => {
  const f = { textWordCount: 900, contentVerification: { isValid: true, confidence: 'high' } };
  assert.equal(detectCvFlagContradiction(f), null);
});

test('CV confidence medium (not high) → null', () => {
  const f = {
    wrongProduction: true, textWordCount: 900,
    contentVerification: { isValid: true, confidence: 'medium' },
  };
  assert.equal(detectCvFlagContradiction(f), null);
});

test('CV isValid false → null (CV itself agrees something is wrong)', () => {
  const f = {
    wrongProduction: true, textWordCount: 900,
    contentVerification: { isValid: false, confidence: 'high' },
  };
  assert.equal(detectCvFlagContradiction(f), null);
});

test('word count at/under 300 → null (too short to trust)', () => {
  const f = {
    wrongProduction: true, textWordCount: 300,
    contentVerification: { isValid: true, confidence: 'high' },
  };
  assert.equal(detectCvFlagContradiction(f), null);
});

test('human-decided file never fires (manual clear wins over CV)', () => {
  const f = {
    wrongProduction: true, textWordCount: 900,
    wrongProductionManualClear: true,
    contentVerification: { isValid: true, confidence: 'high' },
  };
  assert.equal(detectCvFlagContradiction(f), null);
});

test('no contentVerification → null', () => {
  assert.equal(detectCvFlagContradiction({ wrongProduction: true, textWordCount: 900 }), null);
});

test('null/undefined data → null (never throws)', () => {
  assert.equal(detectCvFlagContradiction(null), null);
  assert.equal(detectCvFlagContradiction(undefined), null);
});
