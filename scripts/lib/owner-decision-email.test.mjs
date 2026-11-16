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
