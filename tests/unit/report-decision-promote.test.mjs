// BRO-8152: a paused report's DECISION NEEDED block must reach the description, the only
// text the owner emailer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { promotedDecisionDescription, PROMOTED_MARKER } = require('../../scripts/lib/report-owner-question-guard.js');
const { findOwnerDecisions } = require('../../scripts/lib/owner-decision-notify.js');

const SUMMARY = 'Checked the four shows.\nDECISION NEEDED: Should the Critic Score show after 3 reviews for The Afronauts?\nOption A - lower: shows sooner / thinner\nMy recommendation: A.';

test('paused report with a block is copied to the top of the description and the emailer then sees it', () => {
  const out = promotedDecisionDescription({ status: 'paused', summary: SUMMARY, description: 'Original body' });
  assert.ok(out.startsWith('DECISION NEEDED: Should the Critic Score'));
  assert.ok(out.includes(PROMOTED_MARKER) && out.endsWith('Original body'));
  assert.equal(findOwnerDecisions([{ identifier: 'BRO-1', description: 'Original body', priority: 2 }]).length, 0);
  assert.equal(findOwnerDecisions([{ identifier: 'BRO-1', description: out, priority: 2 }]).length, 1);
});

test('inline block inside a paragraph (the BRO-7980 shape) is promoted from the marker on', () => {
  const out = promotedDecisionDescription({ status: 'blocked', summary: 'Report text. DECISION NEEDED: pick A or B for the gate? Recommendation: A.', description: '' });
  assert.ok(out && out.startsWith('DECISION NEEDED: pick A or B'));
});

test('no change for done reports, reports without a block, or cards that already carry one', () => {
  assert.equal(promotedDecisionDescription({ status: 'done', summary: SUMMARY, description: 'x' }), null);
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: 'Throttled by design, no owner decision needed.', description: 'x' }), null);
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: SUMMARY, description: 'DECISION NEEDED: older question?' }), null);
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: 'DECISION NEEDED: <what, one sentence>', description: 'x' }), null);
});

test('review findings: heading-form card block, dash form, answered repeat, idempotence', () => {
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: SUMMARY, description: '## DECISION NEEDED\nShould we ship the gate now?\nMore.' }), null);
  const dash = promotedDecisionDescription({ status: 'paused', summary: 'Report. DECISION NEEDED - pick A or B for the gate?', description: 'x' });
  assert.ok(dash && dash.startsWith('DECISION NEEDED: pick A or B'));
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: SUMMARY,
    description: 'Answered 2026-11-01: Should the Critic Score show after 3 reviews for The Afronauts? Chose A.' }), null);
  // Ordinary context that restates the question is not an answer.
  assert.ok(promotedDecisionDescription({ status: 'paused', summary: SUMMARY,
    description: 'Task: Should the Critic Score show after 3 reviews for The Afronauts? Investigate.' }));
  const once = promotedDecisionDescription({ status: 'paused', summary: SUMMARY, description: 'Body' });
  assert.equal(promotedDecisionDescription({ status: 'paused', summary: SUMMARY, description: once }), null);
});

test('ship-check findings: fenced and inline-code examples are never promoted; verification-only, CRLF and heading summaries are', () => {
  const fenced = promotedDecisionDescription({ status: 'paused', description: 'Body',
    summary: 'Format:\n```\nDECISION NEEDED: example question here?\n```\nDECISION NEEDED: real one, pick A?' });
  assert.ok(fenced.startsWith('DECISION NEEDED: real one, pick A?'));
  assert.ok(!fenced.includes('example question') && !fenced.includes('```'));
  const span = promotedDecisionDescription({ status: 'paused', description: 'Body',
    summary: 'Per rule `DECISION NEEDED: foo` format. DECISION NEEDED: real pick A?' });
  assert.ok(span.startsWith('DECISION NEEDED: real pick A?'));
  const verif = promotedDecisionDescription({ status: 'paused', description: 'Body', summary: 'Stopped.',
    verification: 'DECISION NEEDED: fund the rescrape or not?' });
  assert.ok(verif && verif.startsWith('DECISION NEEDED: fund the rescrape'));
  assert.ok(promotedDecisionDescription({ status: 'paused', description: 'Body', summary: 'x\r\nDECISION NEEDED: pick A or B today?\r\n' }));
  const heading = promotedDecisionDescription({ status: 'paused', description: 'Body', summary: '## DECISION NEEDED\nShould we ship the gate now?' });
  assert.ok(heading === null || findOwnerDecisions([{ identifier: 'BRO-1', description: heading, priority: 2 }]).length === 1);
  assert.equal(promotedDecisionDescription({ status: 'paused', description: 'Body', summary: 'Example only: `DECISION NEEDED: foo?`' }), null);
});
