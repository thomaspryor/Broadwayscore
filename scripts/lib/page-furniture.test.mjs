// BRO-7171 Stage 5: page furniture carried into stored review bodies.
// Lines are real corpus/archive lines (scripts/audit-page-furniture.js).
// Requires the real functions (rule 15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PF = require('./page-furniture.js');
const { cleanRecord, skipReason, tierChangeRefusal, TRIM_REASON } = require('./page-furniture-record.js');
const { stripTrailingJunk } = require('./text-cleaning.js');
const TQ = require('./text-quality.js');
const AE = require('./article-extractor.js');
const { chooseOutletOrGeneric } = require('../collect-review-texts.js');

const P1 = 'The production is handsome and the leads are strong, but the second act drags and the staging never quite earns its final image of reconciliation.';
const P2 = 'Still, the score is lovely, the orchestra plays it with real care, and the ensemble sells every number with conviction and a welcome sense of humour.';
const P3 = 'It is a flawed but generous evening, and the audience around me seemed to have a wonderful time from the overture to the final bow of the night.';
const BODY = [P1, P2, P3].join('\n\n');

const FURNITURE = {
  share: ['Share on X (Opens in new window)', 'Facebook', 'Email', 'Share:'],
  related: ['Related Stories', 'Latest Reviews', 'See all', 'Most Popular'],
  comments: ['Leave a Comment', '0 Comments / 0 New'],
  booking: ['Buy Tickets', 'Buy tickets for Hamlet with Evening Standard Tickets', 'Tickets from $49'],
  boilerplate: [
    'Invest in The Stage today with a subscription starting at just £9.99.',
    'By entering your email address you agree to our Terms of Use and Privacy Policy and consent to receive emails from Time Out.',
    'Thanks for subscribing! Look out for your first newsletter in your inbox soon!',
    'Support arts and culture journalism today.',
    'Your product is saved! You’ll receive emails when your saved products go on sale.',
    'Web production by Tipit — Powered by News Gecko',
    'Already a member? Log in to hide these messages.',
    'Unlimited Digital AccessOnly 25¢for 6 months',
  ],
  copyright: ['© 2024 Penske Media Corporation', 'Copyright 2012 Dow Jones & Company, Inc. All Rights Reserved'],
};

test('every known furniture line is categorised', () => {
  for (const [cat, lines] of Object.entries(FURNITURE)) {
    for (const l of lines) assert.strictEqual(PF.lineFurnitureCategory(l), cat, l);
  }
});

test('prose that mentions tickets, sharing, newsletters or copyright is not furniture', () => {
  for (const l of [
    P1,
    'Tickets are available at the box office and run through March 3.',
    'Running time: 2 hours 30 minutes, including one intermission.',
    'She shares the stage with a superb ensemble, and the email scene is the funniest thing in it.',
    'Copyright law looms over the plot, which turns on who owns the late composer’s estate.',
    'Read more of the novel and you will see what the adaptation leaves out.',
  ]) assert.strictEqual(PF.lineFurnitureCategory(l), null, l);
});

test('stripPageFurniture removes mid-article and trailing furniture, keeps every prose paragraph', () => {
  const text = [P1, 'Share on X (Opens in new window)', 'Facebook', 'Related Stories', 'Hamilton Sets Closing Date', 'A Theater Legend Dies at 90', P2, P3, 'Leave a Comment', '© 2024 Penske Media Corporation'].join('\n\n');
  const out = PF.stripPageFurniture(text);
  assert.strictEqual(out, BODY);
  assert.deepStrictEqual(PF.detectPageFurniture(out), []);
});

test('repeated paragraph keeps the first copy only', () => {
  const out = PF.stripPageFurniture([P1, P2, P1, P3].join('\n\n'));
  assert.strictEqual(out, BODY);
});

test('an all-furniture body is returned unchanged, never blanked', () => {
  const junk = 'Facebook\n\nEmail\n\nLeave a Comment';
  assert.strictEqual(PF.stripPageFurniture(junk), junk);
});

test('tailGuard keeps cut-to-end anchors so the WSJ copyright tail is cut whole (archive parity regression)', () => {
  const tail = 'Copyright 2012 Dow Jones & Company, Inc. All Rights Reserved\n\nOpera Review: A Bold New Tosca\n\nThe Week in Film';
  const guarded = PF.stripPageFurniture(`${BODY}\n\n${tail}`, { tailGuard: true });
  assert.match(guarded, /Copyright 2012 Dow Jones/);
  const out = stripTrailingJunk(`${BODY}\n\n${tail}`);
  assert.doesNotMatch(out, /Dow Jones|Bold New Tosca|Week in Film/);
  assert.match(out, /final bow of the night\.$/);
});

test('save path and scoring view share the one stripper', () => {
  const text = `${BODY}\n\nInvest in The Stage today with a subscription starting at just £9.99.\n\nFacebook`;
  assert.doesNotMatch(stripTrailingJunk(text), /Invest in The Stage|Facebook/);
  assert.doesNotMatch(TQ.stripTrailingJunk(text), /Invest in The Stage|Facebook/);
});

test('kill switch PAGE_FURNITURE_DISABLED and TRAILER_FIXES_DISABLED make the stripper a no-op', () => {
  const text = `${BODY}\n\nFacebook`;
  for (const k of ['PAGE_FURNITURE_DISABLED', 'TRAILER_FIXES_DISABLED']) {
    process.env[k] = 'true';
    try {
      assert.strictEqual(PF.stripPageFurniture(text), text, k);
      assert.ok(PF.detectPageFurniture(text).length, 'detector still reports');
    } finally { delete process.env[k]; }
  }
});

test('cleanRecord: hash of the prior text, word counts, stale pull quote dropped', () => {
  const d = { fullText: `${BODY}\n\nFacebook\n\nBuy Tickets`, textWordCount: 999, wordCount: 999, llmPullQuote: 'Buy Tickets' };
  const { record, removed } = cleanRecord(d, '2026-11-09T00:00:00Z');
  assert.strictEqual(record.fullText, BODY);
  assert.strictEqual(record.textWordCount, BODY.split(/\s+/).length);
  assert.strictEqual(record.llmPullQuote, null);
  assert.strictEqual(record.fullTextTrimmed.reason, TRIM_REASON);
  assert.match(record.fullTextTrimmed.priorFullTextHash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(record.fullTextTrimmed.categories, ['booking', 'share']);
  assert.strictEqual(removed.length, 2);
  assert.strictEqual(cleanRecord({ fullText: BODY }, 'x'), null, 'nothing to remove');
});

test('skipReason leaves locked, manual and Theatre Record lift records alone', () => {
  const t = `${BODY}\n\nFacebook`;
  assert.strictEqual(skipReason({ fullText: t, _locked: true }), 'locked');
  assert.strictEqual(skipReason({ fullText: t, fetchMethod: 'manual-entry' }), 'manual-entry');
  assert.strictEqual(skipReason({ fullText: t, fullTextTrimmed: { reason: 'TR lift BRO-6154' } }), 'tr-lift-breadcrumb');
  for (const d of [{ fullText: t, _locked: true }, { fullText: t, fetchMethod: 'manual-entry' }]) assert.strictEqual(cleanRecord(d, 'x'), null);
});

test('tierChangeRefusal: no downgrades, no promotion out of invalid', () => {
  assert.strictEqual(tierChangeRefusal('complete', 'complete'), null);
  assert.strictEqual(tierChangeRefusal('truncated', 'complete'), null);
  assert.strictEqual(tierChangeRefusal('complete', 'truncated'), 'tier-downgrade');
  assert.strictEqual(tierChangeRefusal('complete', 'invalid'), 'tier-downgrade');
  assert.strictEqual(tierChangeRefusal('invalid', 'complete'), 'invalid-upgrade');
});

test('effectiveHost reads hosts, URLs and Wayback URLs', () => {
  assert.strictEqual(AE.effectiveHost('www.thestage.co.uk'), 'thestage.co.uk');
  assert.strictEqual(AE.effectiveHost('https://www.TheStage.co.uk/reviews/x'), 'thestage.co.uk');
  assert.strictEqual(AE.effectiveHost('https://web.archive.org/web/20190101000000/https://www.variety.com/2019/x'), 'variety.com');
});

test('hasOutletExtractor: known outlet yes, unknown blog no', () => {
  assert.strictEqual(AE.hasOutletExtractor('https://www.thestage.co.uk/reviews/x'), true);
  assert.strictEqual(AE.hasOutletExtractor('https://some-unknown-theatre-blog.example/x'), false);
});

test('chooseOutletOrGeneric: outlet text wins unless the generic pass adds real prose', () => {
  const longer = `${BODY}\n\nFacebook\n\nEmail\n\nLeave a Comment`;
  assert.strictEqual(chooseOutletOrGeneric(BODY, longer).source, 'outlet');
  const extra = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} carries new critical argument about the director's choices, the design, the casting of the lead and the pacing of the second half of the evening.`).join('\n\n');
  assert.strictEqual(chooseOutletOrGeneric(BODY, `${BODY}\n\n${extra}`).source, 'generic');
  assert.strictEqual(chooseOutletOrGeneric('', BODY).text, BODY);
});
