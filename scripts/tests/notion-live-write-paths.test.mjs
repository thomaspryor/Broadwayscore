// BRO-3018 sweep guard: fails when a NEW file gains a live channel to the
// retired Notion board, and when an allowlisted file stops having one (so the
// inventory in docs/notion-linear-residue-sweep.md cannot rot).
//
// Every verdict below is explained in that doc. To add a file here you must
// give it a verdict; "live" is not accepted, because a new live Notion write is
// exactly what this test exists to stop (file it on Linear instead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { notionChannels } = require('../lib/notion-residue-scan.js');
const ROOT = join(import.meta.dirname, '..', '..');

// verdict: chokepoint | dead | mirror-update | read-only | text-only | additive-deadend
const ALLOW = {
  'scripts/notion-brain.js': 'chokepoint',               // create exits 6 (notion-write-guard.js)
  'scripts/lib/notion-writes.js': 'chokepoint',          // single pages.update helper
  'scripts/lib/notion-create-safety.js': 'chokepoint',   // post-create verification, only reached via notion-brain create
  'scripts/notion-action-poll.js': 'dead',               // launchd job disabled 2026-08-30
  'scripts/autonomous-merge.js': 'dead',                 // autonomous loop retired 2026-07-27; workflow is dispatch-only
  'scripts/autonomous-run.js': 'dead',
  'scripts/autonomous-triage.js': 'dead',
  'scripts/audit-archived-in-progress.js': 'dead',       // manual, no scheduler
  'scripts/audit-orphan-inprogress.js': 'dead',
  'scripts/notify-pending-commercial-notion.js': 'dead', // workflows call the -linear twin
  'scripts/sync-pending-review-to-notion.js': 'dead',
  'scripts/bsc-prune.js': 'mirror-update',               // local task store -> Notion card updates, never creates
  'scripts/bsc-reconcile.js': 'mirror-update',
  'scripts/reconcile-dead-completions.js': 'mirror-update',
  'scripts/notion-tasks-sync.js': 'mirror-update',
  'scripts/enrich-card-acceptance.js': 'mirror-update',  // Notion leg is opt-in (--source); workflow now passes linear
  'scripts/freeze-ledgers.js': 'read-only',
  'scripts/lib/stuck-work.js': 'read-only',              // data_sources query (POST but a read)
  'scripts/linear-brain.js': 'text-only',                // USAGE text contrasting with notion-brain
  'scripts/bsc-next.js': 'text-only',                    // hint strings only
  'scripts/lib/dispatch-guards.js': 'text-only',         // refusal text naming the legacy command
  'src/app/api/autonomous-action/route.ts': 'additive-deadend', // morning-digest 'Dispatch a fix' tap creates a Notion card the disabled poller never reads (BRO-4718)
  'src/lib/notion-api.ts': 'additive-deadend',
  'src/app/api/feedback/route.ts': 'additive-deadend',
  'src/app/api/submit-review/route.ts': 'additive-deadend',           // feedback + submit-review still create a Notion page (see doc, BRO-3018 follow-up)
};
const VERDICTS = new Set(['chokepoint', 'dead', 'mirror-update', 'read-only', 'text-only', 'additive-deadend']);

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts|tsx|sh|py|yml|plist|md)$/.test(e.name)
      && !/\.test\.(js|mjs|ts)$/.test(e.name) && !/[\\/](tests|__tests__)[\\/]/.test(p)) out.push(p);
  }
}
const files = [];
for (const r of ['scripts', 'src', '.github/workflows', '.github/actions']) walk(join(ROOT, r), files);
const live = new Map();
for (const f of files) {
  const ch = notionChannels(readFileSync(f, 'utf8'), f);
  if (ch.length) live.set(relative(ROOT, f), ch);
}

test('no file outside the allowlist has a live Notion channel', () => {
  assert.ok(files.length > 500, `scan looks truncated (${files.length} files)`);
  const unknown = [...live.keys()].filter((f) => !(f in ALLOW));
  assert.deepEqual(unknown, [],
    `new live Notion channel(s) ${JSON.stringify(unknown)}. Notion is retired: use scripts/linear-brain.js. ` +
    'If this is a deliberate read-only helper, add it to ALLOW with a verdict and a line in docs/notion-linear-residue-sweep.md.');
});

test('allowlist has no stale entries', () => {
  const stale = Object.keys(ALLOW).filter((f) => !live.has(f));
  assert.deepEqual(stale, [], `allowlisted but no longer a Notion channel, remove: ${JSON.stringify(stale)}`);
  for (const v of Object.values(ALLOW)) assert.ok(VERDICTS.has(v));
});

test('every allowlisted file is named in the inventory doc', () => {
  const doc = readFileSync(join(ROOT, 'docs/notion-linear-residue-sweep.md'), 'utf8');
  const missing = Object.keys(ALLOW).filter((f) => !doc.includes(f));
  assert.deepEqual(missing, []);
});

test('detector: comments are ignored, real channels are caught', () => {
  assert.deepEqual(notionChannels("// notion.pages.create({})\n/* api.notion.com */\nconst x = 1;"), []);
  assert.deepEqual(notionChannels("await notion.pages.create({});"), ['sdk-write']);
  assert.deepEqual(notionChannels("fetch('https://api.notion.com/v1/pages')"), ['http']);
  assert.deepEqual(notionChannels("execFileSync('node', ['scripts/notion-brain.js', 'create', t])"), ['brain-cli']);
  assert.deepEqual(notionChannels("run: node scripts/notion-brain.js update $ID", 'w.yml'), ['brain-cli']);
  assert.deepEqual(notionChannels("Notion is retired; never run notion-brain.js.", 'p.md'), []);
  assert.deepEqual(notionChannels("const { x } = require('./lib/notion-writes');"), ['helper']);
  assert.deepEqual(notionChannels("import { createNotionPage } from '@/lib/notion-api';", 'r.ts'), ['helper']);
  assert.deepEqual(notionChannels("# node scripts/notion-brain.js create x", 'a.sh'), []);
});
