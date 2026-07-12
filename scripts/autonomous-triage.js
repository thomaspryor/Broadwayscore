#!/usr/bin/env node
/**
 * autonomous-triage.js — nightly triage pass of the autonomous loop.
 *
 * Reads Not-started Notion backlog cards, runs the deterministic eligibility
 * pre-filter (scripts/lib/autonomous-eligibility.js), then a per-card Sonnet
 * call validated against scripts/lib/triage-schema.json (one retry echoing
 * validation errors, then failed("triage") — never a silent skip), and writes
 * the night's work plan to data/audit/autonomous-queue.json.
 *
 *   node scripts/autonomous-triage.js --dry-run              triage, write queue, NO Notion writes
 *   node scripts/autonomous-triage.js --dry-run --limit 5    first 5 backlog cards
 *   node scripts/autonomous-triage.js --cards id1,id2        explicit card ids (testing)
 *   node scripts/autonomous-triage.js                        live: also stamps Auto=queued/failed
 *
 * Live mode only touches the dedicated `Auto` select (never Status, never
 * domain Tags). The executor (scripts/autonomous-run.js) consumes the queue.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { triageCard, decide, orderQueue } = require('./lib/autonomous-triage-core.js');

const REPO = path.join(__dirname, '..');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
const MODEL = process.env.AUTONOMOUS_TRIAGE_MODEL || 'claude-sonnet-5';

// .env may be absent in a worktree (gitignored) — fall back to the primary
// checkout so ANTHROPIC_API_KEY / NOTION_API_KEY resolve either way.
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
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try {
          const json = JSON.parse(data);
          resolve(json.content?.[0]?.text || '');
        } catch (e) {
          reject(new Error(`Anthropic parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const limit = args.limit ? parseInt(args.limit, 10) : 30;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }

  // 1. Collect cards.
  let ids;
  if (args.cards) {
    ids = String(args.cards).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    const table = notionBrain(['list', '--status', 'Not started', '--limit', String(limit)]);
    ids = table.map(row => row.id);
  }
  console.error(`[triage] ${ids.length} backlog card(s), model=${MODEL}, mode=${dryRun ? 'dry-run' : 'LIVE'}`);

  // 2. Triage each (sequential — nightly batch, no rush; keeps API load low).
  const entries = [];
  for (const [i, id] of ids.entries()) {
    let card;
    try {
      card = notionBrain(['get', id]);
    } catch (err) {
      entries.push({ card: { id }, preFilter: { eligible: false, reason: `card fetch failed: ${err.message.slice(0, 120)}` }, decision: 'failed', failed: 'fetch' });
      console.error(`[triage] ${i + 1}/${ids.length} ${id} FETCH FAILED`);
      continue;
    }
    // Cards the loop already processed (Auto set) are not re-triaged.
    if (card.auto) {
      entries.push({ card: slim(card), preFilter: { eligible: false, reason: `already in Auto state "${card.auto}"` }, decision: 'skip' });
      console.error(`[triage] ${i + 1}/${ids.length} ${card.name} → skip (auto=${card.auto})`);
      continue;
    }
    const result = await triageCard(card, callSonnet);
    const entry = { card: slim(card), ...result };
    entry.decision = decide(entry);
    entries.push(entry);
    console.error(`[triage] ${i + 1}/${ids.length} ${card.name} → ${entry.decision}${entry.triage ? ` (${entry.triage.size})` : ''}${entry.failed ? ` [${entry.error?.slice(0, 80)}]` : ''}`);
  }

  // 3. Order the attempt plan.
  const plan = orderQueue(entries).map(e => ({
    id: e.card.id, name: e.card.name, priority: e.card.priority,
    size: e.triage.size, checkableDone: e.triage.checkableDone,
  }));

  const queue = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'live',
    model: MODEL,
    counts: {
      total: entries.length,
      attempt: plan.length,
      split: entries.filter(e => e.decision === 'split').length,
      skip: entries.filter(e => e.decision === 'skip').length,
      failed: entries.filter(e => e.decision === 'failed').length,
    },
    plan,
    entries,
  };

  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
  console.error(`[triage] queue written: ${QUEUE_PATH}`);
  console.log(JSON.stringify({ mode: queue.mode, counts: queue.counts, plan: queue.plan }, null, 2));

  // 4. Live mode: stamp Auto on triaged cards (queued / split-proposed / failed).
  //    Dry-run: zero Notion writes.
  if (!dryRun) {
    for (const e of entries) {
      const auto = e.decision === 'attempt' ? 'queued'
        : e.decision === 'split' ? 'split-proposed'
        : e.decision === 'failed' ? 'failed'
        : null;
      if (!auto || !e.card.id) continue;
      try {
        execFileSync('node', [path.join(__dirname, 'notion-brain.js'), 'update', e.card.id, '--auto', auto], {
          cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
        });
      } catch (err) {
        console.error(`[triage] WARN could not stamp Auto=${auto} on ${e.card.id}: ${err.message.slice(0, 120)}`);
      }
    }
  }
}

function slim(card) {
  return {
    id: card.id, url: card.url, name: card.name, status: card.status,
    priority: card.priority, category: card.category, tags: card.tags, auto: card.auto || null,
  };
}

main().catch(err => {
  console.error(`[triage] fatal: ${err.message}`);
  process.exit(1);
});
