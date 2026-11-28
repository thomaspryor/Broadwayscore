import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filerVerifyCommands, guardFilerVerify, preserveFilerVerify } = require('./filer-verify-guard.js');
const { enrichOneCard } = require('../enrich-card-acceptance.js');

const FILER = 'node scripts/check-opening-night-readiness.js --show=ID';
const card = (over = {}) => ({
  id: 'c1', name: 'Fix opening night check', category: 'Product', tags: [],
  notes: `## Problem\nBroken.\n\nVERIFY: ${FILER}`, ...over,
});

test('filerVerifyCommands reads the filer line, skips auto-enriched cards and the owner-judgment marker', () => {
  assert.deepEqual(filerVerifyCommands(card()), [FILER]);
  assert.deepEqual(filerVerifyCommands(card({ tags: ['auto-enriched'] })), []);
  assert.deepEqual(filerVerifyCommands(card({ notes: 'VERIFY: owner-judgment' })), []);
  assert.deepEqual(filerVerifyCommands(card({ notes: 'no verify here' })), []);
});

test('guardFilerVerify rejects a to-be-created path only when the filer wrote a VERIFY', () => {
  const r = guardFilerVerify(card(), ['scripts/opening-night-reviews.test.mjs']);
  assert.equal(r.kind, 'filer-verify-invented-path');
  assert.equal(guardFilerVerify(card(), []), null);
  assert.equal(guardFilerVerify(card({ notes: '## Problem\nBroken.' }), ['tests/unit/x.test.mjs']), null);
});

test('preserveFilerVerify re-attaches a dropped filer line once and leaves a kept one alone', () => {
  const out = preserveFilerVerify(card(), '## Acceptance criteria\n`npx tsc --noEmit` passes');
  assert.match(out, /Filer VERIFY \(kept as written/);
  assert.ok(out.includes(FILER));
  assert.ok(!/^\s*VERIFY:/im.test(out), 'must not mint a VERIFY: line an extractor could pick up');
  const kept = `## Acceptance criteria\n${FILER}`;
  assert.equal(preserveFilerVerify(card(), kept), kept);
});

test('enrichOneCard: filer VERIFY + invented test path is rejected, not written (BRO-6585)', async () => {
  const writes = [];
  const bad = JSON.stringify({
    command: 'node --test scripts/opening-night-reviews.test.mjs',
    acceptanceCriteria: '## Acceptance criteria\n`node --test scripts/opening-night-reviews.test.mjs` passes',
  });
  const r = await enrichOneCard(card(), {
    callLLM: async () => bad,
    notionBrain: (...a) => { writes.push(a); return ''; },
    logPath: path.join(os.tmpdir(), `filer-verify-guard-${process.pid}.jsonl`),
    dryRun: true,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /filer-verify-invented-path/);
});

test('enrichOneCard: a card with no filer VERIFY keeps the to-be-created allowance', async () => {
  const r = await enrichOneCard(card({ notes: '## Problem\nBroken.' }), {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/opening-night-bro6691.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/unit/opening-night-bro6691.test.mjs` passes',
    }),
    notionBrain: () => '',
    logPath: path.join(os.tmpdir(), `filer-verify-guard-${process.pid}.jsonl`),
    dryRun: true,
  });
  assert.equal(r.action, 'llm-enriched');
});

test('enrichOneCard rearm: a to-be-created path is still allowed and the filer line is not re-attached', async () => {
  const r = await enrichOneCard(card({ notes: '## Acceptance criteria\n`test -f scripts/lib/verify-gate.js`\nVERIFY: test -f scripts/lib/verify-gate.js' }), {
    rearm: true, allowHumanWritten: true,
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/rearm-bro6691.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/unit/rearm-bro6691.test.mjs` passes',
    }),
    notionBrain: () => '',
    logPath: path.join(os.tmpdir(), `filer-verify-guard-${process.pid}.jsonl`),
    dryRun: true,
  });
  assert.equal(r.action, 'llm-enriched');
});

test('preserveFilerVerify inserts before the footer, handles backticked and bold lines, ignores fences and placeholders', () => {
  const c = card({ notes: '## Acceptance criteria\n**VERIFY:** `node scripts/x.js` passes\n\n```\nVERIFY: example only\n```\nVERIFY: none (manual)' });
  assert.deepEqual(filerVerifyCommands(c), ['node scripts/x.js']);
  const out = preserveFilerVerify(c, '## Acceptance criteria\n`npx tsc --noEmit` passes\n\nFiled by: session (kind: k)\n', [/^Filed by: /m]);
  assert.ok(out.indexOf('Filer VERIFY') < out.indexOf('Filed by:'));
  assert.ok(out.includes('node scripts/x.js'));
  assert.ok(!out.includes('node scripts/x.js`'));
});

test('guardFilerVerify names every invented path', () => {
  assert.match(guardFilerVerify(card(), ['a.mjs', 'b.mjs']).reason, /a\.mjs, b\.mjs/);
});
