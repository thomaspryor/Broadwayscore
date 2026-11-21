// BRO-6443: "## DECISION NEEDED" heading cards (question on the following line) count as owner decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findOwnerDecisions } = require('./owner-decision-notify.js');
const { findDecisionQuestion, parseDecisionDescription } = require('./decision-card-parse.js');

const card = (identifier, description) => ({ identifier, title: identifier, description });

test('heading-style DECISION NEEDED takes the next non-empty line as the question', () => {
  const out = findOwnerDecisions([card('BRO-1', 'Intro\n\n## DECISION NEEDED\n\nShould we retire the Mac fleet?\nWhy this is your call: spend.\nOption A - Yes: fast / risky\n')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].question, 'Should we retire the Mac fleet?');
  assert.equal(out[0].card.options.length, 1);
});

test('heading with trailing colon and bold works', () => {
  assert.equal(findDecisionQuestion('### **DECISION NEEDED:**\nPick A or B?').question, 'Pick A or B?');
});

test('empty heading section, template placeholder, code fence and settled stub are not decisions', () => {
  for (const d of [
    '## DECISION NEEDED\n\n## Options\nA',
    '## DECISION NEEDED\n',
    '## DECISION NEEDED\n<what, one sentence, plain English>',
    '```\n## DECISION NEEDED\nreal?\n```',
    '## DECISION NEEDED\nAnswered: A',
  ]) assert.equal(findOwnerDecisions([card('BRO-2', d)]).length, 0, d);
});

test('same-line form still wins and plain prose mentions are ignored', () => {
  assert.equal(findDecisionQuestion('DECISION NEEDED: use X?').question, 'use X?');
  assert.equal(findOwnerDecisions([card('BRO-3', 'this has no DECISION NEEDED here')]).length, 0);
  assert.equal(parseDecisionDescription('## DECISION NEEDED\nQ?').question, 'Q?');
});
