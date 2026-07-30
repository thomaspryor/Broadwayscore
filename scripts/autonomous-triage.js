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
 *   node scripts/autonomous-triage.js --dry-run --limit 5    stop after 5 triage CANDIDATES
 *   node scripts/autonomous-triage.js --cards id1,id2        explicit card ids (testing)
 *   node scripts/autonomous-triage.js                        live: also stamps Auto=queued/failed
 *
 * --limit counts cards that REACH the LLM (pre-filter survivors), not raw
 * backlog rows: the fetch pulls up to 4x/120 cards and refills past
 * human-territory/deny-tag/already-processed skips.
 *
 * Live mode only touches the dedicated `Auto` select (never Status, never
 * domain Tags). The executor (scripts/autonomous-run.js) consumes the queue.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { triageCard, decide, orderQueue, isSafeCheckCommand, priorityRank, fetchCardWithRetry } = require('./lib/autonomous-triage-core.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { classifyDataCard } = require('./lib/autonomous-eligibility.js');
const { estimateUSD } = require('./lib/autonomous-budget.js');
const ledgerLib = require('./lib/autonomous-ledger.js');
const ledger = require('./lib/autonomous-ledger.js');
const { loadParkOverrides } = require('./lib/attempt-memory.js');

const REPO = path.join(__dirname, '..');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
const MODEL = process.env.AUTONOMOUS_TRIAGE_MODEL || 'claude-sonnet-5';
// Night-1 fix: the backlog's top is crowded with human-territory P0s, so a
// raw top-N fetch can produce a window with zero workable cards. Fetch a
// deeper slice and stop once `--limit` cards have actually reached the LLM.
const FETCH_MULTIPLIER = 4;
const FETCH_MAX = 120;

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

// Live read of the shared task list (~/.claude/tasks/<list>/ — same dir
// notion-tasks-sync.js reads/writes) for the claim-visibility pre-filter.
// Reuses notion-tasks-sync's OWN identity layer (.notion-map.json: pageId →
// {taskId,...}) rather than scanning every task's description text — same
// dir, same file, no parallel mechanism to drift out of sync. Called fresh
// per card (not snapshotted once for the whole run): triage loops
// sequentially through up to `limit` cards with a real Sonnet call each, so
// a one-time snapshot would leave a claim made mid-run invisible to cards
// triaged later in the same pass (ship-check finding). Cheap: small local
// JSON reads, no network. Best-effort — a session that hasn't set up the
// shared list, or a read hiccup, must never fail the whole triage run; it
// just means the pre-filter can't see any claims this call and falls
// through to the normal eligibility checks (fail-open on infra, not
// fail-open on a real claim).
function loadSharedTaskState() {
  const dir = path.join(os.homedir(), '.claude', 'tasks', process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');
  let notionMap = {};
  try { notionMap = JSON.parse(fs.readFileSync(path.join(dir, '.notion-map.json'), 'utf8')); } catch { /* no map yet */ }
  let files;
  try { files = fs.readdirSync(dir); } catch { return { notionMap: {}, tasksById: {} }; }
  const tasksById = {};
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try { tasksById[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip corrupt task file */ }
  }
  return { notionMap, tasksById };
}

// Running usage across every callSonnet() this process — ledgered once at
// the end of main() so the morning email's "Tonight" block counts triage
// (night-1 fix: 15 Sonnet calls showed as $0.00).
const usageTally = { calls: 0, tokensIn: 0, tokensOut: 0 };

function callSonnet(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: MODEL,
    // Split proposals for L cards run long (300+ chars per child, several
    // children) — 2000 truncated mid-JSON on the first live test.
    max_tokens: 8000,
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
          const u = json.usage || {};
          usageTally.calls++;
          usageTally.tokensIn += (Number(u.input_tokens) || 0)
            + (Number(u.cache_creation_input_tokens) || 0)
            + (Number(u.cache_read_input_tokens) || 0);
          usageTally.tokensOut += Number(u.output_tokens) || 0;
          // content[0] is not always the text block (thinking-capable models
          // may lead with a thinking block) — collect every text block.
          const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          if (json.stop_reason === 'max_tokens') return reject(new Error(`response truncated at max_tokens (${text.length} chars)`));
          resolve(text);
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

const USAGE = `autonomous-triage.js — nightly backlog triage (writes autonomous-queue.json).

Usage:
  node scripts/autonomous-triage.js [--dry-run] [--limit N] [--cards id1,id2] [--tier 1|3]

  --dry-run     triage + write queue, zero Notion Auto stamps (still spends Sonnet)
  --limit N     triage window size (default 30 LLM candidates)
  --cards ...   explicit card ids (test mode — every named card processed)
  --tier 1|3    scope override (default: tier3Enabled in .claude/autonomous-config.json)
  --help, -h    show this message, do nothing else
`;

async function main() {
  // BEFORE any side effect (cousin --help bug class, tasks #260/#263/#264/#266:
  // bare --help used to fall through parseArgs and start a real LIVE triage —
  // Notion fetches + Sonnet spend + Auto stamps).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const limit = args.limit ? parseInt(args.limit, 10) : 30;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }

  // Write-scope tier (owner-approved 2026-07-25): tier 3 opens src/ + scripts/
  // via its own default-deny predicate (autonomous-eligibility.js). Config
  // flag is the production switch; --tier is the dry-run/test override.
  // Fail-soft to tier 1 — a missing/broken config must never widen scope.
  let tier = 1;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'autonomous-config.json'), 'utf8')); }
  catch { /* cfg stays {} — every downstream read below fails soft to a default */ }
  if (args.tier) {
    tier = parseInt(args.tier, 10) === 3 ? 3 : 1;
  } else if (cfg.tier3Enabled === true) {
    tier = 3;
  }

  // Attempt-memory park (owner mandate 2026-07-30, task #635): loaded ONCE
  // per triage run (not per-card) — the ledger and overrides file are both
  // static for the whole pass, so re-reading them per card would just be
  // wasted I/O across up to `limit` cards.
  const attemptMemoryLedgerEntries = (() => { try { return ledger.readEntries().entries; } catch { return []; } })();
  const attemptMemoryOverrides = loadParkOverrides();
  const attemptMemoryMaxFailures = Number.isInteger(cfg.attemptMemoryMaxFailures) ? cfg.attemptMemoryMaxFailures : undefined;

  // 1. Collect cards. Fetch deeper than the triage window (night-1 fix):
  //    prefiltered skips (human categories, deny-tags, already-processed) no
  //    longer consume window slots — we walk the backlog in priority order
  //    until `limit` cards have actually reached the LLM or the fetch runs dry.
  let ids;
  if (args.cards) {
    ids = String(args.cards).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    const fetchLimit = Math.min(limit * FETCH_MULTIPLIER, FETCH_MAX);
    const table = notionBrain(['list', '--status', 'Not started', '--limit', String(fetchLimit)]);
    ids = table.map(row => row.id);
  }
  console.error(`[triage] ${ids.length} backlog card(s) fetched, target ${limit} triage candidate(s), model=${MODEL}, mode=${dryRun ? 'dry-run' : 'LIVE'}`);

  // The runId binds triage → executor → email into one night: the executor
  // adopts queue.runId, so triage's ledger lines count into "Tonight".
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // 2. Triage each (sequential — nightly batch, no rush; keeps API load low).
  const entries = [];
  let candidates = 0;
  for (const [i, id] of ids.entries()) {
    // Window cap applies to backlog mode only — an explicit --cards list is
    // a test invocation and every named card gets processed.
    if (!args.cards && candidates >= limit) {
      console.error(`[triage] window full (${candidates} candidates) — ${ids.length - i} fetched card(s) left for tomorrow`);
      break;
    }
    // One retry before giving up (card #529): the 2026-07-26 live run lost 2
    // otherwise-workable cards to single transient `notion-brain get` failures.
    const fetched = await fetchCardWithRetry(id, cardId => notionBrain(['get', cardId]));
    if (!fetched.ok) {
      // Transient (Notion hiccup) — skip WITHOUT stamping Auto so the card is
      // re-triaged tomorrow, never permanently stranded by one bad fetch.
      entries.push({ card: { id }, preFilter: { eligible: false, reason: `card fetch failed after ${fetched.attempts} attempt(s): ${fetched.error.message.slice(0, 120)}` }, decision: 'skip', transient: true });
      console.error(`[triage] ${i + 1}/${ids.length} ${id} FETCH FAILED after ${fetched.attempts} attempt(s) (skip, no stamp)`);
      continue;
    }
    const card = fetched.card;
    if (fetched.attempts > 1) console.error(`[triage] ${i + 1}/${ids.length} ${id} fetch recovered on attempt ${fetched.attempts}`);
    // Cards the loop already processed (Auto set) are not re-triaged.
    if (card.auto) {
      entries.push({ card: slim(card), preFilter: { eligible: false, reason: `already in Auto state "${card.auto}"` }, decision: 'skip' });
      console.error(`[triage] ${i + 1}/${ids.length} ${card.name} → skip (auto=${card.auto})`);
      continue;
    }
    // Live re-read (night-2 fix, ship-check finding): a one-time snapshot
    // before this loop would go stale across a multi-card, multi-Sonnet-call
    // pass — a claim made mid-run would be invisible to cards triaged after
    // it. This is a cheap local read, no network.
    const taskState = loadSharedTaskState();
    const result = await triageCard(card, callSonnet, {
      taskState, tier,
      attemptMemory: { ledgerEntries: attemptMemoryLedgerEntries, overrides: attemptMemoryOverrides, maxFailures: attemptMemoryMaxFailures },
    });
    if (result.preFilter.eligible) candidates++; // reached the LLM → consumed a window slot
    const entry = { card: slim(card), ...result };
    entry.decision = decide(entry);
    // Defense-in-depth: never persist a non-safe-form command in the queue.
    // The validator only enforces safe forms for eligible verdicts (an
    // ineligible card's check never runs, and erroring there would burn a
    // retry) — but a skipped card's LLM-authored command must not sit in
    // autonomous-queue.json waiting for a future consumer to trust it.
    if (entry.triage && entry.decision !== 'attempt' && !isSafeCheckCommand(entry.triage.checkableDone)) {
      entry.triage = { ...entry.triage, checkableDone: null };
    }
    entries.push(entry);
    console.error(`[triage] ${i + 1}/${ids.length} ${card.name} → ${entry.decision}${entry.triage ? ` (${entry.triage.size})` : ''}${entry.failed ? ` [${entry.error?.slice(0, 80)}]` : ''}`);
  }

  // 3. Order the attempt plan. Each item carries the tier it was triaged
  //    under — the executor picks the matching diff gate and model policy.
  const plan = orderQueue(entries).map(e => ({
    id: e.card.id, name: e.card.name, priority: e.card.priority,
    size: e.triage.size, checkableDone: e.triage.checkableDone, tier,
    // Check targets that don't exist yet — the implementer prompt tells the
    // model creating them is part of the work (card #529). Omitted entirely
    // when empty so existing queue consumers see the unchanged shape.
    ...(e.newCheckPaths && e.newCheckPaths.length ? { newCheckPaths: e.newCheckPaths } : {}),
  }));

  // Tier-2 (Sprint 4): cards Tier-1 correctly skipped for touching data/, but
  // whose class the deterministic predicate recognizes. Consumed by
  // autonomous-run.js's data-card path (verified against the private repos'
  // own verifier scripts, never checkableDone — see scripts/lib/autonomous-data-verify.js).
  const dataPlan = buildDataPlan(entries);

  const queue = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'live',
    model: MODEL,
    tier,
    runId,
    counts: {
      total: entries.length,
      fetched: ids.length,
      candidates,
      attempt: plan.length,
      split: entries.filter(e => e.decision === 'split').length,
      skip: entries.filter(e => e.decision === 'skip').length,
      failed: entries.filter(e => e.decision === 'failed').length,
      dataPlan: dataPlan.length,
    },
    plan,
    dataPlan,
    entries,
  };

  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  // Atomic replace: the executor and email hard-parse this file — a crash
  // mid-write must leave the previous queue intact, never a truncated one.
  fs.writeFileSync(`${QUEUE_PATH}.tmp`, JSON.stringify(queue, null, 2) + '\n');
  fs.renameSync(`${QUEUE_PATH}.tmp`, QUEUE_PATH);
  console.error(`[triage] queue written: ${QUEUE_PATH}`);
  console.log(JSON.stringify({ mode: queue.mode, counts: queue.counts, plan: queue.plan }, null, 2));

  // Ledger the triage spend (night-1 fix: triage tokens were unrecorded and
  // the email showed Tonight $0.00 despite 15 Sonnet calls). Dry-runs spend
  // real money, so they're ledgered too — the note carries the mode.
  if (usageTally.calls > 0) {
    try {
      ledger.appendEntry({
        event: 'triage', runId, model: MODEL,
        tokensIn: usageTally.tokensIn, tokensOut: usageTally.tokensOut,
        usd: estimateUSD(MODEL, usageTally.tokensIn, usageTally.tokensOut),
        note: `${usageTally.calls} LLM call(s) over ${candidates} candidate(s) of ${entries.length} triaged (${queue.mode})`,
      });
    } catch (err) {
      console.error(`[triage] WARN could not ledger triage usage: ${err.message.slice(0, 120)}`);
    }
  }

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
        // Freshness guard (poor man's compare-and-set): a human or parallel
        // session may have moved the card between triage and this stamp —
        // re-read and only stamp cards still untriaged and Not started.
        const fresh = notionBrain(['get', e.card.id]);
        if (fresh.auto || fresh.status !== 'Not started') {
          console.error(`[triage] skip stamp on ${e.card.name}: state moved underneath us (status=${fresh.status}, auto=${fresh.auto || 'none'})`);
          continue;
        }
        execFileSync('node', [path.join(__dirname, 'notion-brain.js'), 'update', e.card.id, '--auto', auto], {
          cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
        });
      } catch (err) {
        console.error(`[triage] WARN could not stamp Auto=${auto} on ${e.card.id}: ${err.message.slice(0, 120)}`);
      }
    }
  }
}

// Tier-2 post-pass (Sprint 4): the Tier-1 LLM prompt only knows Tier-1 paths,
// so every data-pipeline card correctly comes back eligible:false ("touches
// data/") and lands in `decide()`'s 'skip' bucket. classifyDataCard() is a
// deterministic, tag/title predicate (autonomous-eligibility.js) — no second
// LLM call needed — but its `size` estimate is REUSED from the Tier-1 triage
// response when one exists: size is explicitly independent of eligibility in
// that prompt (a card can be well-scoped work that's simply out of Tier-1's
// allowed paths), so re-asking the LLM would just re-derive the same number.
// A pre-filter skip (deny-tag/human-action) never reaches the LLM at all —
// 'M' is a deliberately mid conservative default for that rarer case, not a
// data class's true complexity estimate.
// A skip's reason distinguishes a POLICY exclusion (deny-tag, human-action
// title, marketing/partnerships category — none of these are Tier-2-specific,
// so a data card is still a fair Tier-2 candidate) from a CLAIM exclusion
// (findClaimedTask in autonomous-triage-core.js: an interactive session
// already has this card in_progress right now). Requeuing a claimed card as
// a Tier-2 candidate would undo that protection and race a live session
// (ship-check finding) — the prefix is triageCard's own exact wording, not a
// free-text guess.
const CLAIMED_IN_FLIGHT_RE = /^claimed in-flight/;

// Empirical size floor: if a card's own PAST attempt died on "exceeded
// per-card cap", the LLM's size estimate is proven too small — measured spend
// beats a re-derived guess (2026-07-16: review-write-guard implemented fine in
// 5.4min but was discarded at $2.22 > $1.50 S cap; the next triage re-estimated
// S again, queuing the identical failure). Bump one step per observed cap-fail:
// S→M; M→L parks it for the owner (L is incremental/disabled) rather than
// burning a third attempt that the $3.00 cap already proved too small.
const CAP_EXCEEDED_RE = /exceeded per-card cap/;
const SIZE_BUMP = { S: 'M', M: 'L' };
function capExceededCardIds(entries = null) {
  // readEntries returns { entries, corrupt }, not a bare array.
  const rows = entries || (() => { try { return ledgerLib.readEntries().entries; } catch { return []; } })();
  const ids = new Set();
  for (const r of rows) {
    if (r.event === 'card-fail' && r.cardId && CAP_EXCEEDED_RE.test(String(r.note || ''))) ids.add(r.cardId);
  }
  return ids;
}

function buildDataPlan(entries, capExceeded = capExceededCardIds()) {
  const items = [];
  for (const e of entries) {
    if (e.decision !== 'skip' || !e.card || !e.card.id || e.transient) continue;
    if (e.preFilter && CLAIMED_IN_FLIGHT_RE.test(e.preFilter.reason || '')) continue;
    // Auto-stamped cards (failed/attempted/needs-approval) are unattemptable:
    // attemptDataCard refuses any card with `auto` set, so planning one wedges
    // a slot into a nightly "state moved underneath us" skip. 2026-07-17..19:
    // two auto=failed cards + an L held all 3 slots — three nights, zero
    // attempts. failed stays failed until the OWNER clears it (morning-email
    // triage); it just must not occupy a plan slot meanwhile.
    if (e.card.auto) continue;
    const cls = classifyDataCard(e.card);
    if (!cls) continue;
    let size = e.triage && e.triage.size ? e.triage.size : 'M';
    if (capExceeded.has(e.card.id) && SIZE_BUMP[size]) size = SIZE_BUMP[size];
    items.push({ id: e.card.id, name: e.card.name, priority: e.card.priority, size, class: cls });
  }
  return items.sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    ({ S: 0, M: 1, L: 2 }[a.size] ?? 9) - ({ S: 0, M: 1, L: 2 }[b.size] ?? 9) ||
    String(a.name).localeCompare(String(b.name)));
}

function slim(card) {
  return {
    id: card.id, url: card.url, name: card.name, status: card.status,
    priority: card.priority, category: card.category, tags: card.tags, auto: card.auto || null,
  };
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[triage] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { callSonnet, notionBrain, slim, buildDataPlan, capExceededCardIds, MODEL, QUEUE_PATH };
