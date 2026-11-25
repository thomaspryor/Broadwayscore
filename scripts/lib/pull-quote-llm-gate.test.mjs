// BRO-8334: the LLM yes/no show check. Drives the REAL extractor (CLAUDE.md §15)
// with a stubbed model: a "no" verdict drops the quote (after one retry with a
// hint), "yes" keeps it, "unclear"/garbage keeps it. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./review-write-guard.js')._setShowsCacheForTest(new Map());
const gate = require('./pull-quote-llm-gate.js');

const S = [
  'The production at the Lantern Theatre opened on a damp Thursday evening with a full house.',
  'Its director has staged the piece with an eye for crisp movement and clean sightlines throughout.',
  'The second act gathers pace and the ensemble finds a confident rhythm that carries the finale.',
  'Several songs land with real force, and the orchestrations give the score a generous warmth.',
  'This is a sturdy, enjoyable evening that rewards anyone who loves a well built musical comedy.',
];
const FULL = S.join(' ');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-gate-'));
process.env.REVIEW_TEXTS_DIR = ROOT;
const ex = require('../extract-pull-quotes.js');

let extractCalls = 0, gateCalls = 0, gateReply = 'yes', lastHint = '';
ex._setLLMForTest(async (sys, user) => {
  if (sys === gate.GATE_SYSTEM_PROMPT) { gateCalls++; return gateReply; }
  extractCalls++; lastHint = user;
  return S[3];
});

function fixture(name) {
  const dir = path.join(ROOT, name); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'synthetic-gazette--test-critic.json');
  fs.writeFileSync(file, JSON.stringify({ showId: name, showTitle: 'Lantern Show', outlet: 'Synthetic Gazette', outletId: 'synthetic-gazette', criticName: 'Test Critic', assignedScore: 60, contentTier: 'complete', fullText: FULL }));
  return file;
}
async function run() {
  extractCalls = 0; gateCalls = 0;
  for (const f of ex.scanReviewFiles()) await ex.processReview(f);
}

test('parseGateVerdict: yes/no/unclear, junk keeps the quote', () => {
  assert.equal(gate.parseGateVerdict('No.'), 'no');
  assert.equal(gate.parseGateVerdict(' "Yes" '), 'yes');
  assert.equal(gate.parseGateVerdict('unclear'), 'unclear');
  assert.equal(gate.parseGateVerdict('I cannot say'), 'unclear');
  assert.equal(gate.parseGateVerdict(null), 'unclear');
});

test('a no-verdict drops the quote after one retry and stamps the rejection', async () => {
  gateReply = 'no';
  const f = fixture('gate-no-2026');
  await run();
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(d.llmPullQuote, undefined);
  assert.equal(d.llmPullQuoteRejectReason, 'llm-gate-other-show');
  assert.equal(extractCalls, 2, 'one retry');
  assert.equal(gateCalls, 2);
  assert.match(lastHint, /judged to be about something other than Lantern Show/);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('a yes-verdict keeps the quote', async () => {
  gateReply = 'yes';
  const f = fixture('gate-yes-2026');
  await run();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).llmPullQuote, S[3]);
  assert.equal(gateCalls, 1);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('an unclear verdict keeps the quote', async () => {
  gateReply = 'unclear';
  const f = fixture('gate-unclear-2026');
  await run();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).llmPullQuote, S[3]);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});
