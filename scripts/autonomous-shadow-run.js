#!/usr/bin/env node
/**
 * autonomous-shadow-run.js — proves the attempt-memory park logic against
 * the REAL triageCard() selection path, without ever executing an
 * implementer or writing to Notion (owner mandate 2026-07-30, task #635:
 * "fix the system so that [it doesn't allow] things to be re-attempted and
 * fail and burn money" — the loop stays PAUSED per task #599 until the
 * owner reviews this evidence and decides to re-enable it).
 *
 * Two things this proves, both logged to the shared ledger as `shadow-*`
 * events so they're inspectable after the run:
 *
 *   1. A REAL backlog slice (read-only Notion `list`/`get`, small --limit)
 *      run through the production triageCard() — same function the live
 *      loop uses — with attempt-memory wired in via opts.attemptMemory.
 *      Zero Notion writes (no Auto/Status stamp). The morning-of-2026-07-30
 *      backlog has no ledger lines carrying `contentHash` yet (the field is
 *      new), so no real card parks on this pass — that's the EXPECTED,
 *      correct behavior (a card without failure history is never parked)
 *      and is called out explicitly in the summary, not hidden.
 *
 *   2. A SYNTHETIC probe card, entirely in-memory (no Notion call), seeded
 *      with two fabricated `card-fail` ledger entries at matching
 *      contentHash a full day apart — modeling the exact "failed twice
 *      unchanged" shape the owner mandate is about. This proves the WIRING
 *      (triageCard → attempt-memory.checkPark, not just the pure function
 *      in isolation) correctly skips it with ZERO LLM calls. This is the
 *      one part of the proof that doesn't need to wait for real overnight
 *      failure history to accumulate.
 *
 *   node scripts/autonomous-shadow-run.js [--limit N]   default limit 5
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { triageCard, decide } = require('./lib/autonomous-triage-core.js');
const { computeContentHash, loadParkOverrides } = require('./lib/attempt-memory.js');
const ledger = require('./lib/autonomous-ledger.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = path.join(__dirname, '..');
const MODEL = process.env.AUTONOMOUS_TRIAGE_MODEL || 'claude-sonnet-5';

for (const envPath of [path.join(REPO, '.env'), '/Users/tompryor/Broadwayscore/.env']) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  break;
}

const USAGE = `autonomous-shadow-run.js — proves attempt-memory park logic via the real triageCard() path. NO Notion writes, NO implementer spend.

Usage:
  node scripts/autonomous-shadow-run.js [--limit N]   N real backlog cards triaged in shadow (default 5)
  --help, -h    show this message, do nothing else
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

function callSonnet(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const https = require('https');
  const body = JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try {
          const json = JSON.parse(data);
          const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          resolve(text);
        } catch (e) { reject(new Error(`Anthropic parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// The synthetic probe — models the EXACT shape the owner mandate describes:
// a card that has already failed twice, unchanged, and must never be
// re-offered blind. Fabricated ledger entries + card never touch Notion or
// the real ledger file (they're passed straight into triageCard, not
// appended anywhere) — this is a pure in-memory proof of the wiring.
function buildParkProbe() {
  const card = {
    id: 'shadow-probe-park-9f3c',
    name: '[shadow probe] repeatedly-failing synthetic card',
    priority: 'P9',
    category: null,
    tags: [],
    notes: '## Problem\nSynthetic card used only to prove attempt-memory park logic in shadow mode — never a real backlog item.',
  };
  const hash = computeContentHash(card);
  const ledgerEntries = [
    { ts: '2026-07-28T02:00:00Z', event: 'card-fail', cardId: card.id, contentHash: hash, note: 'checks-failed: tsc error (shadow probe night 1)' },
    { ts: '2026-07-29T02:00:00Z', event: 'card-fail', cardId: card.id, contentHash: hash, note: 'checks-failed: lint error (shadow probe night 2)' },
  ];
  return { card, ledgerEntries };
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const limit = args.limit ? parseInt(args.limit, 10) : 5;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }

  const runId = `shadow-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  ledger.appendEntry({ event: 'shadow-run-start', runId, note: `attempt-memory shadow proof — limit ${limit}, NO Notion writes, NO implementer` });

  // ── Part 1: synthetic park probe (proves the WIRING, needs no real data) ──
  const probe = buildParkProbe();
  const probeResult = await triageCard(probe.card, async () => { throw new Error('LLM should NEVER be called for a parked card'); }, {
    attemptMemory: { ledgerEntries: probe.ledgerEntries },
  });
  const probeParked = probeResult.preFilter && probeResult.preFilter.eligible === false && /^parked:/.test(probeResult.preFilter.reason || '');
  ledger.appendEntry({
    event: 'shadow-probe', runId, cardId: probe.card.id, name: probe.card.name,
    note: probeParked ? `PASS — parked without an LLM call: "${probeResult.preFilter.reason}"` : `FAIL — probe card was NOT parked (preFilter=${JSON.stringify(probeResult.preFilter)})`,
  });
  console.log(`[shadow] probe (synthetic, failed-twice-unchanged): ${probeParked ? 'PASS — parked, zero LLM calls' : 'FAIL — see ledger'}`);
  if (!probeParked) {
    ledger.appendEntry({ event: 'shadow-run-end', runId, note: 'aborted: park-probe FAILED — attempt-memory wiring is broken, do not trust real-card results below' });
    console.error('[shadow] ABORT — the synthetic park probe failed. Attempt-memory wiring is broken; not proceeding to real cards.');
    process.exit(1);
  }

  // ── Part 2: a real backlog slice through the production selection path ──
  let ids = [];
  try {
    const table = notionBrain(['list', '--status', 'Not started', '--limit', String(limit)]);
    ids = table.map(row => row.id);
  } catch (err) {
    ledger.appendEntry({ event: 'shadow-run-end', runId, note: `real-card slice skipped: notion list failed (${err.message.slice(0, 150)})` });
    console.error(`[shadow] WARN could not fetch real backlog cards: ${err.message.slice(0, 150)} — probe result above still stands`);
    return;
  }

  const attemptMemoryLedgerEntries = ledger.readEntries().entries;
  const attemptMemoryOverrides = loadParkOverrides();
  let parkedCount = 0, attemptCount = 0, skipCount = 0, otherCount = 0;
  for (const id of ids) {
    let card;
    try { card = notionBrain(['get', id]); }
    catch (err) {
      ledger.appendEntry({ event: 'shadow-card', runId, cardId: id, note: `fetch failed: ${err.message.slice(0, 120)}` });
      continue;
    }
    if (card.auto) {
      ledger.appendEntry({ event: 'shadow-card', runId, cardId: id, name: card.name, note: `skip — already in Auto state "${card.auto}"` });
      skipCount++;
      continue;
    }
    const result = await triageCard(card, callSonnet, {
      attemptMemory: { ledgerEntries: attemptMemoryLedgerEntries, overrides: attemptMemoryOverrides },
    });
    const d = decide({ ...result, decision: undefined });
    if (result.preFilter && result.preFilter.eligible === false && /^parked:/.test(result.preFilter.reason || '')) {
      parkedCount++;
      ledger.appendEntry({ event: 'shadow-card', runId, cardId: id, name: card.name, note: `would-park: ${result.preFilter.reason}` });
    } else if (d === 'attempt') {
      attemptCount++;
      ledger.appendEntry({ event: 'shadow-card', runId, cardId: id, name: card.name, note: `would-attempt (size ${result.triage.size})` });
    } else {
      otherCount++;
      ledger.appendEntry({ event: 'shadow-card', runId, cardId: id, name: card.name, note: `decision=${d}` });
    }
    console.log(`[shadow] ${card.name} → ${d}${result.preFilter && !result.preFilter.eligible ? ` (${result.preFilter.reason.slice(0, 80)})` : ''}`);
  }

  const summary = `probe PASS · ${ids.length} real card(s): ${attemptCount} would-attempt, ${parkedCount} would-park, ${skipCount} auto-skip, ${otherCount} other — real-card parkedCount is expected to be 0 until ≥2 nights of contentHash-bearing card-fail ledger entries accumulate post-deploy`;
  ledger.appendEntry({ event: 'shadow-run-end', runId, note: summary });
  console.log(`[shadow] done: ${summary}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[shadow] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildParkProbe, main };
