// BRO-7578: the owner got a decision email about two iPhone design rounds with no
// picture and no visible link, so they could not tell what they were approving.
// These pin: mockup links (from the card or the cards it names) and the card link
// sit above every answer button, and a look-and-feel question with nothing to look
// at is held back instead of emailed blind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildDecisionEmail, pictureHold } = require('./owner-decision-email.js');

const CANVAS = 'https://claude.ai/artifact/DNuC3f3GhMtFkgQnxaChos';
// The real BRO-7562 text (shortened): no link of its own, names BRO-6213 and BRO-6176.
const QUESTION = 'Do you want the two iPhone design rounds (BRO-6213 compact Upcoming/tab order, BRO-6176 ideas from the inspiration app) built, or dropped?';
const DESC = `DECISION NEEDED: ${QUESTION}\n\nOption A: build both design rounds. Option B: drop them. Recommendation: A for BRO-6213.\n\n## Acceptance criteria\n\nVERIFY: owner-judgment`;
// BRO-6213 as Linear stores it: the canvas as [url](<url>).
const RELATED = [`Published to canvas [${CANVAS}](<${CANVAS}>).`];
const decision = { identifier: 'BRO-7562', title: 'iPhone app batch round 2', url: 'https://linear.app/broadway-scorecard/issue/BRO-7562/x', question: QUESTION };
const secret = 'test-secret';

test('mockups from a named card and the card link appear above the answer buttons', () => {
  const { html } = buildDecisionEmail({ decision, description: DESC, related: RELATED, secret, now: 0 });
  const mock = html.indexOf(`href="${CANVAS}"`);
  const card = html.indexOf(`href="${decision.url}"`);
  const firstAnswer = html.indexOf('/api/owner-decision?t=');
  assert.ok(mock > 0, 'the canvas link is in the email');
  assert.match(html, /See the mockups/);
  assert.ok(card > 0 && card < firstAnswer, 'card link sits above the first answer button');
  assert.ok(mock < firstAnswer, 'mockups sit above the first answer button');
});

test('no mockups found: the card link still sits above the buttons', () => {
  const { html } = buildDecisionEmail({ decision, description: DESC, secret, now: 0 });
  assert.doesNotMatch(html, /See the mockups/);
  assert.ok(html.indexOf(`href="${decision.url}"`) < html.indexOf('/api/owner-decision?t='));
});

test('a design question with nothing to look at is held; a link on a named card releases it', () => {
  assert.match(pictureHold({ question: QUESTION, description: DESC }), /no screenshot/);
  assert.equal(pictureHold({ question: QUESTION, description: DESC, related: RELATED }), null);
  assert.equal(pictureHold({ question: QUESTION, description: `${DESC}\n${CANVAS}` }), null);
});

test('a question that is not about looks is never held for a picture', () => {
  assert.equal(pictureHold({ question: 'Should we rescore 400 reviews with the new prompt?', description: 'DECISION NEEDED: Should we rescore 400 reviews with the new prompt?' }), null);
  assert.equal(pictureHold({ question: 'Do you want the Resend plan upgraded to $20 a month?', description: 'x' }), null);
});

test('a held design question is emailed anyway a day after the card was asked for a picture', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.match(pictureHold({ question: QUESTION, description: DESC, askedAt: '2026-11-16T01:00:00Z', now }), /no screenshot/);
  assert.equal(pictureHold({ question: QUESTION, description: DESC, askedAt: '2026-11-15T10:00:00Z', now }), null);
});

test('ordinary words like "look into" or "screen" do not mark a question as visual', () => {
  for (const q of ['Should we look into the Resend bounce rate?', 'Can I screen out roundup reviews before scoring?', 'Is the new scraper worth a look?']) {
    assert.equal(pictureHold({ question: q, description: 'x' }), null, q);
  }
  for (const q of ['Which layout should the Upcoming tab use?', 'Does the badge look right in the corner?', 'Approve the icon colors?']) {
    assert.match(pictureHold({ question: q, description: 'x' }), /no screenshot/, q);
  }
});

test('published, code and escaped mockup links are all found whole, and only the first 4 named cards count', () => {
  const { mockupLinks, relatedCardIds } = require('../../src/lib/owner-decision-link.js');
  assert.deepEqual(mockupLinks('see https://claude.ai/public/artifacts/0a1b2c3d-4e5f-6789-abcd-ef0123456789 now'), ['https://claude.ai/public/artifacts/0a1b2c3d-4e5f-6789-abcd-ef0123456789']);
  assert.deepEqual(mockupLinks('https://claude.ai/artifact/abc\\_defghij'), ['https://claude.ai/artifact/abc_defghij']);
  assert.deepEqual(mockupLinks('https://claude.ai/code/artifact/1234567890'), ['https://claude.ai/code/artifact/1234567890']);
  assert.deepEqual(relatedCardIds('BRO-1 BRO-2 BRO-9 BRO-3 BRO-4 BRO-5', 'BRO-9'), ['BRO-1', 'BRO-2', 'BRO-3', 'BRO-4']);
});

test('the mockups link is styled apart from the answer buttons', () => {
  const html = buildDecisionEmail({ decision: { identifier: 'BRO-7562', title: 't', url: 'https://linear.app/x/issue/BRO-7562', question: QUESTION }, description: `${DESC}\n${CANVAS}`, secret: 's' }).html;
  assert.match(html, /See the mockups <span[^>]*>\(opens a picture\)<\/span>/);
});

test('questions show no card ids or link markup to the owner', () => {
  const { displayQuestion } = require('../../src/lib/owner-decision-link.js');
  assert.equal(displayQuestion("Should the iPhone app's round 4 design ([BRO-6213](https://linear.app/x/issue/BRO-6213/ios-y)) be built?"), "Should the iPhone app's round 4 design be built?");
  assert.equal(displayQuestion('Do you want the rounds (BRO-6213 compact Upcoming, BRO-6176 ideas) built?'), 'Do you want the rounds (compact Upcoming, ideas) built?');
  assert.equal(displayQuestion('Use the [new layout](<https://example.com/a>) here? (ref 0123456789abcdef0123456789abcdef)'), 'Use the new layout here?');
  assert.equal(displayQuestion('Upgrade Resend to $20 a month?'), 'Upgrade Resend to $20 a month?');
});

test('the About line shows no card ids', () => {
  const html = buildDecisionEmail({ decision: { identifier: 'BRO-7562', title: 'iPhone app batch round 2: 5 of the 16 app-repo cards from BRO-6869 are still Todo', url: 'https://linear.app/x/issue/BRO-7562', question: QUESTION }, description: DESC, secret: 's' }).html;
  assert.match(html, /About: iPhone app batch round 2: 5 of the 16 app-repo cards from are still Todo/);
  assert.doesNotMatch(html, /About:[^<]*BRO-/);
});

test('owner-facing decision pages never print a card id as text', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  for (const f of ['src/app/api/owner-decision/route.ts', 'src/app/api/owner-decision/list/route.ts', 'scripts/lib/owner-decision-email.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /\$\{esc\([^)]*\.identifier\)\}/, `${f} prints a card id`);
    assert.doesNotMatch(src, /About: \$\{esc\((?:noDash\()?[\w.?]*title\)/, `${f} prints a raw title (ids and link markup) in About`);
  }
});
