#!/usr/bin/env node
/**
 * Audit GitHub Actions workflow activity: last-run timestamp, state, run counts.
 *
 * Buckets each workflow file into:
 *   DISABLED       — GitHub auto-disabled (HTTP 422 on dispatch, or disabled state)
 *   NEVER-RUN      — no run history in the API (workflow exists but has never fired)
 *   IDLE-60D+      — last run > 60 days ago (GitHub auto-disables ~60d; risk of silent disable)
 *   IDLE-30D       — last run 30-60 days ago (watching brief)
 *   ACTIVE         — last run < 30 days ago
 *
 * Usage:
 *   node scripts/audit-workflow-activity.js            # print full report (uses cache)
 *   node scripts/audit-workflow-activity.js --json     # JSON output
 *   node scripts/audit-workflow-activity.js --force    # bypass cache, fetch fresh data
 *
 * Requires: GH_TOKEN env var (or GITHUB_TOKEN) with repo access.
 * Rate limit: each workflow = 2 API calls (info + last run); 186 workflows = 372 calls total.
 * Cache: results stored in /tmp/bwsc-workflow-activity-cache.json (24h TTL).
 *        Re-running within 24h costs 0 API calls. Use --force to bypass.
 * Concurrency: 5 workers with 500ms inter-call spacing to stay under secondary rate limits.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const REPO = 'thomaspryor/Broadwayscore';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const JSON_OUTPUT = process.argv.includes('--json');
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 5;
const CALL_SPACING_MS = 500;
const CACHE_FILE = '/tmp/bwsc-workflow-activity-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Critical workflows from check-cron-health.yml — these MUST stay active.
// Entries have format: "workflow.yml|max_hours|Name"
function parseCriticalCrons() {
  const chFile = path.join(WORKFLOW_DIR, 'check-cron-health.yml');
  if (!fs.existsSync(chFile)) return new Set();
  const raw = fs.readFileSync(chFile, 'utf8');
  // Each CRITICAL_CRONS entry looks like: "some-workflow.yml|36|Name"
  const workflows = [...raw.matchAll(/"([a-z0-9_-]+\.yml)\|/g)].map(m => m[1]);
  return new Set(workflows);
}

// Load cache; returns {} on miss/error/force.
function loadCache() {
  if (FORCE) return {};
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache = JSON.parse(raw);
    // Purge keys for workflow files that no longer exist
    const existing = new Set(
      fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    );
    for (const key of Object.keys(cache)) {
      if (!existing.has(key)) delete cache[key];
    }
    return cache;
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch { /* best-effort */ }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function apiGet(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'bwsc-workflow-audit',
      },
    };
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', async () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        } else if (res.statusCode === 403 && retries > 0) {
          // Secondary rate limit — back off and retry
          const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
          const delay = Math.max(retryAfter * 1000, 10000);
          if (!JSON_OUTPUT) {
            process.stderr.write(`  ⏳ Secondary rate limit hit, waiting ${Math.round(delay / 1000)}s...\n`);
          }
          await sleep(delay);
          try { resolve(await apiGet(url, retries - 1)); } catch (e) { reject(e); }
        } else {
          resolve({ _status: res.statusCode, _body: body });
        }
      });
    }).on('error', reject);
  });
}

async function getWorkflowId(filename) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${filename}`;
  const data = await apiGet(url);
  if (!data || data._status) return null;
  return { id: data.id, state: data.state, name: data.name };
}

async function getLastRun(workflowId) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${workflowId}/runs?per_page=1`;
  const data = await apiGet(url);
  if (!data || data._status) return null;
  const runs = data.workflow_runs ?? [];
  if (runs.length === 0) return null;
  return {
    createdAt: runs[0].created_at,
    conclusion: runs[0].conclusion,
    status: runs[0].status,
    runNumber: runs[0].run_number,
  };
}

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function bucket(state, lastRun) {
  if (state === 'disabled_manually' || state === 'disabled_inactivity') return 'DISABLED';
  if (!lastRun) return 'NEVER-RUN';
  const d = daysSince(lastRun.createdAt);
  if (d > 60) return 'IDLE-60D+';
  if (d > 30) return 'IDLE-30D';
  return 'ACTIVE';
}

async function processWorkflow(filename, cache) {
  const now = Date.now();
  const cached = cache[filename];
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.result;
  }

  await sleep(CALL_SPACING_MS);
  const info = await getWorkflowId(filename);
  if (!info) {
    const result = { filename, bucket: 'UNKNOWN', error: 'not found in API' };
    cache[filename] = { fetchedAt: now, result };
    return result;
  }
  await sleep(CALL_SPACING_MS);
  const lastRun = await getLastRun(info.id);
  const result = {
    filename,
    name: info.name,
    state: info.state,
    bucket: bucket(info.state, lastRun),
    lastRunAt: lastRun?.createdAt ?? null,
    daysSinceLast: lastRun ? daysSince(lastRun.createdAt) : null,
    lastConclusion: lastRun?.conclusion ?? null,
    runNumber: lastRun?.runNumber ?? null,
  };
  cache[filename] = { fetchedAt: now, result };
  return result;
}

// Bounded concurrency pool
async function runPool(items, fn, concurrency) {
  const results = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!TOKEN) {
    console.error('❌ GH_TOKEN or GITHUB_TOKEN env var required');
    process.exit(1);
  }

  const files = fs.readdirSync(WORKFLOW_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const cache = loadCache();
  const staleCount = files.filter(f => {
    const c = cache[f];
    return !c || (Date.now() - c.fetchedAt) >= CACHE_TTL_MS;
  }).length;
  const fromCache = files.length - staleCount;

  if (!JSON_OUTPUT) {
    if (fromCache > 0 && !FORCE) {
      console.error(`Auditing ${files.length} workflows — ${fromCache} from cache, ${staleCount} fetching (${CONCURRENCY} concurrent, 500ms spacing)...`);
    } else {
      console.error(`Auditing ${files.length} workflows (${CONCURRENCY} concurrent, 500ms spacing)...`);
    }
  }

  const results = await runPool(files, (f) => processWorkflow(f, cache), CONCURRENCY);
  saveCache(cache);

  const criticalCrons = parseCriticalCrons();

  const buckets = {
    DISABLED: [],
    'NEVER-RUN': [],
    'IDLE-60D+': [],
    'IDLE-30D': [],
    ACTIVE: [],
    UNKNOWN: [],
  };
  for (const r of results) {
    (buckets[r.bucket] ?? buckets.UNKNOWN).push(r);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ results, criticalCrons: [...criticalCrons], summary: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])) }, null, 2));
    return;
  }

  const now = new Date().toISOString().slice(0, 10);
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Workflow Activity Audit — ${now}`);
  console.log(`  Repo: ${REPO}  |  Total: ${files.length} workflows`);
  if (fromCache > 0 && !FORCE) console.log(`  (${fromCache} results from cache — use --force for fresh data)`);
  console.log(`═══════════════════════════════════════════════════════`);

  if (buckets.DISABLED.length) {
    console.log(`\n🔴 DISABLED (${buckets.DISABLED.length}) — GitHub auto-disabled or manually disabled`);
    for (const r of buckets.DISABLED) {
      const crit = criticalCrons.has(r.filename) ? ' ⚠️  IN CRITICAL_CRONS' : '';
      console.log(`   ${r.filename} [state: ${r.state}]${crit}`);
    }
    console.log(`   ↳ Re-enable: gh workflow enable <filename>`);
  }

  if (buckets['NEVER-RUN'].length) {
    console.log(`\n⚫ NEVER RUN (${buckets['NEVER-RUN'].length}) — exists but has never fired`);
    for (const r of buckets['NEVER-RUN']) {
      const crit = criticalCrons.has(r.filename) ? ' ⚠️  IN CRITICAL_CRONS' : '';
      console.log(`   ${r.filename}${crit}`);
    }
  }

  if (buckets['IDLE-60D+'].length) {
    console.log(`\n🟠 IDLE 60D+ (${buckets['IDLE-60D+'].length}) — at risk of auto-disable`);
    for (const r of buckets['IDLE-60D+'].sort((a, b) => (b.daysSinceLast ?? 0) - (a.daysSinceLast ?? 0))) {
      const crit = criticalCrons.has(r.filename) ? ' ⚠️  IN CRITICAL_CRONS' : '';
      const last = r.lastRunAt ? `${r.daysSinceLast}d ago` : 'never';
      console.log(`   ${r.filename} — last run: ${last}${crit}`);
    }
    console.log(`   ↳ GitHub auto-disables after ~60d of inactivity (HTTP 422 on dispatch)`);
  }

  if (buckets['IDLE-30D'].length) {
    console.log(`\n🟡 IDLE 30-60D (${buckets['IDLE-30D'].length}) — watching brief`);
    for (const r of buckets['IDLE-30D'].sort((a, b) => (b.daysSinceLast ?? 0) - (a.daysSinceLast ?? 0))) {
      const crit = criticalCrons.has(r.filename) ? ' ⚠️  IN CRITICAL_CRONS' : '';
      console.log(`   ${r.filename} — last run: ${r.daysSinceLast}d ago${crit}`);
    }
  }

  console.log(`\n✅ ACTIVE (${buckets.ACTIVE.length}) — ran in last 30 days`);

  if (buckets.UNKNOWN.length) {
    console.log(`\n❓ UNKNOWN (${buckets.UNKNOWN.length}) — API lookup failed`);
    for (const r of buckets.UNKNOWN) console.log(`   ${r.filename}: ${r.error}`);
  }

  // Summary
  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`  Summary:`);
  for (const [k, v] of Object.entries(buckets)) {
    if (v.length) console.log(`    ${k.padEnd(12)} ${v.length}`);
  }
  console.log(`\n  Critical crons found in check-cron-health.yml: ${criticalCrons.size}`);
  const critDisabled = [...criticalCrons].filter(c => buckets.DISABLED.some(r => r.filename === c));
  if (critDisabled.length) {
    console.log(`  ⚠️  CRITICAL + DISABLED: ${critDisabled.join(', ')}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
