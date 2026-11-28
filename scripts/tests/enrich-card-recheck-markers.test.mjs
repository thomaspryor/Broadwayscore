// BRO-2170: stale enricher-stamped "VERIFY: owner-judgment" markers must be
// re-evaluated, not left to starve technical cards forever. Rule 15: every
// assertion goes through the REAL exported functions and the REAL gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  decideMarkerRecheck, applyMarkerRemoval, hasEnricherStamp, stripEnricherMarker,
} = require('../enrich-card-acceptance.js');
const { isCardEligible } = require('../lib/autonomous-eligibility.js');
const { classifyHeadlessDispatchability } = require('../lib/headless-dispatchability.js');
const { evaluateVerifiability } = require('../lib/verify-gate.js');

const LOG = path.join(os.tmpdir(), `recheck-markers-${process.pid}.jsonl`);

// A technical deny-tag card stamped by the OLD enricher rule (pre-#1186).
const staleTechnical = () => ({
  id: 'x1', name: 'Score recalibration policy tweak', category: null,
  tags: ['scoring', 'auto-enriched'],
  notes: '## Problem\nTune the extractor threshold.\n\nVERIFY: owner-judgment',
});
// A genuinely human card the enricher stamped correctly.
const humanStamped = () => ({
  id: 'x2', name: 'Call NY business phone for EIN', category: null,
  tags: ['auto-enriched'],
  notes: 'Phone the state.\n\nVERIFY: owner-judgment',
});

test('fixture sanity: stale technical card is deny-tag (not human-territory) under the CURRENT classifier', () => {
  const e = isCardEligible({ name: staleTechnical().name, category: null, tags: staleTechnical().tags });
  assert.equal(e.eligible, false);
  assert.equal(e.kind, 'deny-tag');
  assert.equal(isCardEligible({ name: humanStamped().name, category: null, tags: [] }).kind, 'human-territory');
});

test('human-territory card keeps its marker', () => {
  const d = decideMarkerRecheck(humanStamped());
  assert.equal(d.decision, 'keep');
  assert.match(d.reason, /human-territory/);
});

test('hand-written marker (reason in parentheses, no label) is never removed, even on an eligible title', () => {
  const d = decideMarkerRecheck({
    id: 'x3', name: 'Fix the flaky retry loop', tags: [],
    notes: 'Body\n\nVERIFY: owner-judgment (needs a live dry-run against real pages)',
  });
  assert.equal(d.decision, 'keep');
  assert.match(d.reason, /not stamped by the enricher/);
  assert.equal(hasEnricherStamp('x\n\nVERIFY: owner-judgment (reason)', ['auto-enriched']), false);
});

test('stamped card whose text still says DECISION NEEDED keeps the marker', () => {
  const c = staleTechnical();
  c.notes = 'DECISION NEEDED: pick a policy.\n\nVERIFY: owner-judgment';
  assert.equal(decideMarkerRecheck(c).decision, 'keep');
});

test('no marker at all is outside the population', () => {
  assert.equal(decideMarkerRecheck({ id: 'x4', name: 'n', tags: [], notes: 'plain' }).decision, 'none');
});

test('deny-tag technical card: marker removed AND acceptance criteria armed (not merely unblocked)', async () => {
  const card = staleTechnical();
  const before = classifyHeadlessDispatchability({ subject: card.name, description: card.notes });
  assert.ok(before.blockers.some(b => b.code === 'OWNER_DECISION_GATE'), 'precondition: marker blocks dispatch');

  const decision = decideMarkerRecheck(card);
  assert.equal(decision.decision, 'remove');
  assert.doesNotMatch(decision.strippedNotes, /owner-judgment/i);

  const writes = [];
  const result = await applyMarkerRemoval(card, decision, {
    logPath: LOG,
    callLLM: async () => JSON.stringify({
      acceptanceCriteria: 'The threshold test passes.',
      command: 'node --test scripts/enrich-card-acceptance.test.mjs',
    }),
    writeCard: async (c, notes) => { writes.push(notes); },
  });

  assert.equal(result.action, 'llm-enriched', result.detail);
  assert.equal(writes.length, 1, 'exactly one write');
  const written = writes[0];
  assert.doesNotMatch(written, /VERIFY:\s*owner-judgment/i, 'marker gone from written notes');
  assert.equal(evaluateVerifiability(written).armed, true);
  const after = classifyHeadlessDispatchability({ subject: card.name, description: written });
  assert.equal(after.dispatchable, true, after.reason || '');
});

test('failed draft writes nothing: the marker stays so a retry is safe', async () => {
  const card = staleTechnical();
  const writes = [];
  const result = await applyMarkerRemoval(card, decideMarkerRecheck(card), {
    logPath: LOG,
    callLLM: async () => { throw new Error('provider down'); },
    writeCard: async (c, notes) => { writes.push(notes); },
  });
  assert.equal(result.action, 'failed');
  assert.equal(writes.length, 0);
});

test('stripEnricherMarker removes only bare marker lines', () => {
  assert.equal(stripEnricherMarker('a\n\nVERIFY: owner-judgment\n\n## Outcome\nb'), 'a\n\n## Outcome\nb');
  assert.match(stripEnricherMarker('a\n\nVERIFY: owner-judgment (why)'), /owner-judgment \(why\)/);
});

test('card already armed with a command keeps a later-added bare marker (deliberate)', () => {
  const c = staleTechnical();
  c.notes = '## Acceptance criteria\n`node --test scripts/enrich-card-acceptance.test.mjs`\n\nVERIFY: owner-judgment';
  const d = decideMarkerRecheck(c);
  assert.equal(d.decision, 'keep');
  assert.match(d.reason, /already has a runnable/);
});

test('a second reasoned marker survives the strip and keeps the card', () => {
  const c = staleTechnical();
  c.notes = 'Body\n\nVERIFY: owner-judgment\n\nVERIFY: owner-judgment (needs a human call)';
  assert.equal(decideMarkerRecheck(c).decision, 'keep');
});

test('BRO-2962 regression: PARKED spend-decision card keeps its marker', () => {
  const c = staleTechnical();
  c.name = 'Browserbase costs ~$190/mo: Tier 1.5 opens sessions daily';
  c.tags = ['auto-enriched'];
  c.notes = 'PARKED: owner call on spend vs coverage.\n\n## Problem\nx\n\nVERIFY: owner-judgment';
  const d = decideMarkerRecheck(c);
  assert.equal(d.decision, 'keep');
  assert.match(d.reason, /PARKED|owner call/);
});

test('audit log keeps the ORIGINAL notes (marker included) for rollback', async () => {
  const fs = await import('node:fs');
  const card = staleTechnical();
  const log = path.join(os.tmpdir(), `recheck-rollback-${process.pid}.jsonl`);
  await applyMarkerRemoval(card, decideMarkerRecheck(card), {
    logPath: log,
    callLLM: async () => JSON.stringify({ acceptanceCriteria: 'ok', command: 'node --test scripts/enrich-card-acceptance.test.mjs' }),
    writeCard: async () => {},
  });
  const row = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.match(row.previousNotes, /VERIFY: owner-judgment/);
  assert.doesNotMatch(row.newNotes, /VERIFY: owner-judgment/);
});
