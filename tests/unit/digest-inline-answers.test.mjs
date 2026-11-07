// BRO-6715: every card that waits on the owner gets signed one-tap answer buttons in the morning digest,
// including a card that carries BOTH a DECISION NEEDED block and the awaiting-owner label (visual asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { answerButtonsFor } = require('../../scripts/lib/digest-answer-buttons.js');
const { buildAwaitingOwnerSection } = require('../../scripts/lib/owner-approval-channel.js');
const { buildDecisionsSection } = require('../../scripts/lib/owner-decision-notify.js');
const { renderNamedDigestBlock } = require('../../scripts/lib/autonomous-email-render.js');
const link = require('../../src/lib/owner-decision-link.js');

const SECRET = 'test-secret-not-real';
const NOW = new Date('2026-10-31T11:30:00Z');
const label = [{ name: 'awaiting-owner' }];
const DECISION = [
  'DECISION NEEDED: Which data should we store?',
  'Why this is your call: it is a product call.',
  'Option A — Store everything: complete history / more rows',
  'Option B — Latest only: small / loses history',
  'My recommendation: B because it is simpler.',
  'If you do not answer: B.',
].join('\n');
const issue = (identifier, description, labels = []) => ({
  identifier, title: `${identifier} title`, description, url: `https://linear.app/x/issue/${identifier}`,
  labels: { nodes: labels }, createdAt: '2026-10-29T00:00:00Z', priority: 2,
});
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

test('label plus decision block: one awaiting row with its options and a button per option', () => {
  const sec = buildAwaitingOwnerSection([issue('BRO-11', DECISION, label)], { now: NOW, secret: SECRET });
  const [row] = sec.items;
  assert.equal(row.decision.options.length, 2);
  assert.deepEqual(row.answerButtons.map((b) => b.key), ['a', 'b', 'own']);
  const url = new URL(row.answerButtons[0].url);
  assert.equal(url.pathname, '/api/owner-decision');
  assert.equal(url.searchParams.get('o'), 'a');
  assert.equal(link.verifyToken(url.searchParams.get('t'), SECRET).ok, true);
  assert.equal(link.verifyToken(url.searchParams.get('t'), SECRET).id, 'BRO-11');
});

test('label-only card with no block still gets approve / reject / own words', () => {
  const sec = buildAwaitingOwnerSection([issue('BRO-12', 'Needs a yes.', label)], { now: NOW, secret: SECRET });
  assert.deepEqual(sec.items[0].answerButtons.map((b) => b.key), ['approve', 'reject', 'own']);
});

test('decision card without the label gets buttons in the decisions section', () => {
  const sec = buildDecisionsSection([issue('BRO-13', DECISION)], { now: NOW, secret: SECRET });
  assert.deepEqual(sec.items[0].answerButtons.map((b) => b.key), ['a', 'b', 'own']);
});

test('no secret, or a dry run, means no tokens', () => {
  assert.equal(answerButtonsFor(issue('BRO-14', DECISION), { secret: '' }), null);
  process.env.DIGEST_NO_LIST_TOKEN = '1';
  try { assert.equal(answerButtonsFor(issue('BRO-14', DECISION), { secret: SECRET }), null); } finally { delete process.env.DIGEST_NO_LIST_TOKEN; }
});

test('the rendered email carries the answer links, the recommended pick filled in, and the card link', () => {
  const sec = buildAwaitingOwnerSection([issue('BRO-11', DECISION, label)], { now: NOW, secret: SECRET });
  const html = renderNamedDigestBlock('Waiting on your approval', sec, { actionCards: true, showBanner: true });
  const links = hrefs(html);
  assert.equal(links.filter((h) => h.includes('/api/owner-decision?')).length, 3);
  assert.ok(links.includes('https://linear.app/x/issue/BRO-11'));
  assert.ok(!/Open →/.test(html));
  assert.match(html, /background-color:#1d4ed8;border:1px solid #1d4ed8;font-weight:700[^>]*>Option B: Latest only/);
  assert.match(html, /Reply in my own words/);
});

test('without buttons the old single link is unchanged', () => {
  const sec = buildAwaitingOwnerSection([issue('BRO-15', 'Needs a yes.', label)], { now: NOW, secret: '' });
  const html = renderNamedDigestBlock('Waiting on your approval', sec, { actionCards: true, showBanner: true });
  assert.match(html, /Open →/);
});

// BRO-6715: BRO-6176 wrote its decision as a heading with the question on the next line. The Linear
// reply parser accepted it, the email/answer-link parser did not, so the digest showed no buttons.
test('a heading-style decision block is folded into the one-line form the answer links read', () => {
  const parse = require('../../scripts/lib/decision-card-parse.js');
  const desc = 'Intro\n\n## DECISION NEEDED (owner)\n\nWhich ideas to build. Recommended starting set: 1, 2, 3 and 5.\n\n## Acceptance criteria\n\n* x\n';
  const canon = parse.canonicalizeDecisionHeading(desc);
  assert.equal(link.markerLines(desc).length, 0, 'the answer-link parser misses the heading form');
  assert.equal(link.markerLines(canon).length, 1);
  assert.equal(parse.findDecisionQuestion(canon).question, parse.findDecisionQuestion(desc).question);
  assert.equal(parse.canonicalizeDecisionHeading(canon), canon, 'idempotent');
  const plain = 'DECISION NEEDED: already one line\n\nbody';
  assert.equal(parse.canonicalizeDecisionHeading(plain), plain);
  const fenced = '```\n## DECISION NEEDED\n\nexample\n```\n';
  assert.equal(parse.canonicalizeDecisionHeading(fenced), fenced);
});

test('a row whose description never loaded gets no buttons (it would be signed against the wrong question)', () => {
  const issue = { identifier: 'BRO-9', title: 'Looks label-only', labels: { nodes: [{ name: 'awaiting-owner' }] } };
  assert.equal(answerButtonsFor(issue, { secret: 's', now: Date.now() }), null);
  assert.ok(answerButtonsFor({ ...issue, description: '' }, { secret: 's', now: Date.now() }), 'an empty description is a real label-only card');
});

test('heading rewrite keeps bold balanced and leaves shapes it cannot fold alone', () => {
  const parse = require('../../scripts/lib/decision-card-parse.js');
  const fold = (h) => parse.canonicalizeDecisionHeading(`x\n\n${h}\n\nWhich one?\n`);
  assert.match(fold('## **DECISION NEEDED (owner):**'), /\*\*DECISION NEEDED \(owner\):\*\* Which one\?/);
  assert.match(fold('## **DECISION NEEDED**'), /\*\*DECISION NEEDED\*\*: Which one\?/);
  const odd = `x\n\n## **DECISION NEEDED (owner)**\n\nWhich one?\n`;
  assert.equal(parse.canonicalizeDecisionHeading(odd), odd);
});
