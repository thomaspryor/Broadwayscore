#!/usr/bin/env node
'use strict';
/**
 * gap-terminal.js — mark reviews whose full text cannot be recovered as
 * terminal (BRO-7171 Stage 4). Policy and the record shape live in
 * scripts/lib/gap-terminal.js; this is the only writer of textUnrecoverable.
 *
 * Only historic shows, and only rows the gap-recovery driver has nothing left
 * to try (its own dry-run plan). Terminal reviews keep their score and excerpt;
 * they only stop counting as open gaps and stop being retried.
 *
 *   node scripts/gap-terminal.js                    # dry run: counts per group
 *   node scripts/gap-terminal.js --owner-batch      # write the owner's one-reply batch file
 *   node scripts/gap-terminal.js --apply-auto       # write OUTLET_DEFUNCT / NEVER_ONLINE records
 *   node scripts/gap-terminal.js --apply-owner-batch=<batch.json> --approve=A,B --approved-by="<owner reply>"
 *
 * Exit codes: 0 ok, 1 failed, 3 another recovery run holds the run lock.
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { execFileSync } = require('child_process');

const GT = require('./lib/gap-terminal');
const L = require('./lib/gap-recovery-ledger');

const argv = process.argv.slice(2);
const arg = (n) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const flag = (n) => argv.includes(`--${n}`);

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(os.homedir(), '.broadwayscore-state', 'gap-recovery');
const OUT_DIR = path.join(os.homedir(), 'Documents', 'claude-outputs');
const TODAY = new Date().toISOString().slice(0, 10);
const GROUP_LETTER = { PAYWALL_NO_ACCESS: 'A', URL_DEAD_NO_ARCHIVE: 'B', NOT_FINDABLE: 'C' };
const GROUP_PLAIN = {
  PAYWALL_NO_ACCESS: 'Telegraph reviews we can no longer open (subscription cancelled in July)',
  URL_DEAD_NO_ARCHIVE: 'Reviews whose web page is gone and the Internet Archive never saved a copy',
  NOT_FINDABLE: 'Older reviews we only know from a quote on a review-roundup site, with no link to the original',
};

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** The driver's own dry-run plan for historic shows (rows with nothing left to try have strategy null). */
function driverPlan() {
  const out = path.join(os.tmpdir(), `gap-terminal-plan-${process.pid}.json`);
  execFileSync(process.execPath, [path.join(__dirname, 'gap-recovery-driver.js'), '--dry-run', '--historic-only', `--json=${out}`], { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 1 << 26 });
  const plan = readJson(out);
  fs.unlinkSync(out);
  return plan.candidates;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }

async function deadHostsFor(hosts) {
  const dead = new Map();
  for (const h of hosts) {
    try { await dns.lookup(h); } catch (e) {
      if (e.code === 'ENOTFOUND') {
        // Confirm once more (transient resolver failure is not evidence).
        try { await dns.lookup(`www.${h}`); } catch (e2) { if (e2.code === 'ENOTFOUND') dead.set(h, `ENOTFOUND ${TODAY}`); }
      }
    }
  }
  return dead;
}

async function build() {
  const outlets = (() => { const r = readJson(path.join(ROOT, 'data', 'outlet-registry.json')); return r.outlets || r; })();
  const rows = driverPlan();
  const byKey = new Map();
  for (const r of L.readRows(L.ledgerPathDefault())) {
    if (!byKey.has(r.reviewKey)) byKey.set(r.reviewKey, []);
    byKey.get(r.reviewKey).push(r);
  }
  const hostFor = (row) => hostOf(row.url) || ((outlets[row.outletId] || {}).domain || null);
  const hosts = new Set(rows.filter((r) => r.recency === 'historic' && !r.strategy).map(hostFor).filter(Boolean));
  const deadHosts = await deadHostsFor(hosts);
  return { groups: GT.groupTerminalCandidates(rows, byKey, { deadHosts, hostFor }), hostsChecked: hosts.size, deadHosts };
}

function printGroups({ groups, hostsChecked, deadHosts }) {
  console.log(`hosts checked: ${hostsChecked}, not resolving: ${deadHosts.size} ${JSON.stringify([...deadHosts.keys()])}`);
  console.log(`auto-terminal (OUTLET_DEFUNCT): ${groups.auto.length}`);
  for (const [g, list] of Object.entries(groups.owner)) console.log(`owner group ${GROUP_LETTER[g]} ${g}: ${list.length}`);
  console.log(`stays open: ${JSON.stringify(groups.open)}`);
}

/** Write records under the shared review-texts lock, then commit + push (same path as the driver). */
function writeRecords(items, { decidedBy, approvedBy = null, label }) {
  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const { readReviewForUpdate, persistReviewSnapshot } = require('./lib/persist-review-snapshot');
  const { checkpointReviewTexts, createWriteTracker } = require('./lib/review-texts-checkpoint');
  const dir = process.env.REVIEW_TEXTS_DIR || resolveReviewTextsDir();
  const tracker = createWriteTracker();
  // Recency from today's shows.json, not the batch file's: a batch can sit for
  // days and a show's dates can be corrected meanwhile. Unknown dates refuse.
  const { recencyOf } = require('./lib/text-gap-classify');
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const showById = new Map((showsRaw.shows || showsRaw).map((s) => [s.id, s]));
  let written = 0;
  const refused = {};
  for (const it of items) {
    const { recency, dateKnown } = recencyOf(showById.get(it.reviewKey.split('/')[0]), Date.now());
    if (!dateKnown || recency !== 'historic') { refused.not_historic = (refused.not_historic || 0) + 1; continue; }
    const filePath = path.join(dir, it.reviewKey);
    withReviewTextsLock(`gap-terminal:${it.reviewKey}`, () => {
      const data = readReviewForUpdate(filePath);
      // The file must still be what was judged: same url, still not complete.
      if ((data.url || null) !== (it.url || null)) { refused.url_changed = (refused.url_changed || 0) + 1; return; }
      if (data.contentTier === 'complete') { refused.now_complete = (refused.now_complete || 0) + 1; return; }
      data.textUnrecoverable = GT.buildTerminalRecord({ review: data, reason: it.reason, evidence: it.evidence, decidedBy, approvedBy });
      if (!GT.validateTerminal(data, { recency }).valid) { refused.invalid = (refused.invalid || 0) + 1; return; }
      delete data.textUnrecoverableClearReason;
      persistReviewSnapshot({ filePath, data, trailingNewline: true });
      tracker.add(path.resolve(filePath));
      written++;
    });
  }
  if (tracker.size) {
    const res = checkpointReviewTexts({ repoDir: dir, paths: [...tracker], expected: tracker.expected, message: `feat: gap-terminal ${label} - ${written} review(s) marked text-unrecoverable (BRO-7171 Stage 4)`, meta: { source: 'gap-terminal' } });
    console.log(`  [checkpoint] ${res.pushed ? 'pushed' : 'nothing to push'}; ${res.landed.length} file(s) confirmed on origin/main`);
  }
  console.log(`written ${written}; refused ${JSON.stringify(refused)}`);
  return written;
}

function takeLock(label) {
  const { acquireRunLock, RunLockBusyError } = require('./lib/recovery-run-lock');
  try { acquireRunLock(label); return true; } catch (e) {
    if (e instanceof RunLockBusyError) { console.log(`gap-terminal: ${e.message}; not running.`); return false; }
    throw e;
  }
}

function writeOwnerBatch(groups) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const batchJson = path.join(STATE_DIR, `owner-batch-${TODAY}.json`);
  const items = {};
  for (const [g, list] of Object.entries(groups.owner)) {
    items[g] = list.map(({ row, evidence }) => ({ reviewKey: row.reviewKey, url: row.url || null, reason: g, evidence }));
  }
  fs.writeFileSync(batchJson, JSON.stringify({ createdAt: new Date().toISOString(), items }, null, 2));
  const total = Object.values(items).reduce((n, l) => n + l.length, 0);
  const lines = [
    `# Reviews we cannot get the full text of (${TODAY})`,
    '',
    `${total} older reviews (shows that opened more than two years ago) have no route left to recover their full text.`,
    'If you approve a group, those reviews stop counting as missing text. They still count toward each show\'s score at their current weight, using the quote we already have. Nothing is deleted. Reviews of shows from the last two years are never on this list.',
    '',
  ];
  for (const [g, list] of Object.entries(items)) {
    if (!list.length) continue;
    lines.push(`## Group ${GROUP_LETTER[g]}: ${GROUP_PLAIN[g]} (${list.length})`, '');
    for (const it of list.slice(0, 8)) lines.push(`- ${it.reviewKey.replace(/\.json$/, '').replace('/', ': ')}`);
    if (list.length > 8) lines.push(`- and ${list.length - 8} more`);
    lines.push('');
  }
  lines.push('## How to answer', '', 'Reply with one line, for example: `approve A, C` or `approve none`.', '');
  const md = path.join(OUT_DIR, `gap-recovery-owner-batch-${TODAY}.md`);
  fs.writeFileSync(md, lines.join('\n'));
  // Read by the morning digest's gap-recovery line.
  fs.writeFileSync(path.join(STATE_DIR, 'owner-batch-pending.json'), JSON.stringify({ date: TODAY, count: total, file: md, batch: batchJson }, null, 2));
  console.log(`owner batch: ${total} review(s) -> ${md}\n  machine list: ${batchJson}`);
}

async function main() {
  if (arg('apply-owner-batch')) {
    const approve = String(arg('approve') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const approvedBy = arg('approved-by');
    if (!approvedBy) { console.error('--approved-by="<the owner\'s reply>" is required'); return 1; }
    const batch = readJson(arg('apply-owner-batch'));
    const groups = Object.entries(GROUP_LETTER).filter(([, l]) => approve.includes(l)).map(([g]) => g);
    const items = groups.flatMap((g) => batch.items[g] || []);
    if (!takeLock('gap-terminal --apply-owner-batch')) return 3;
    writeRecords(items, { decidedBy: 'owner', approvedBy, label: `owner batch ${approve.join(',')}` });
    try { fs.unlinkSync(path.join(STATE_DIR, 'owner-batch-pending.json')); } catch { /* none */ }
    return 0;
  }
  const built = await build();
  printGroups(built);
  if (flag('owner-batch')) writeOwnerBatch(built.groups);
  if (flag('apply-auto')) {
    if (!takeLock('gap-terminal --apply-auto')) return 3;
    const items = built.groups.auto.map(({ row, reason, evidence }) => ({ reviewKey: row.reviewKey, url: row.url || null, reason, evidence }));
    writeRecords(items, { decidedBy: 'gap-terminal-auto', label: 'auto' });
  }
  return 0;
}

main().then((c) => { process.exitCode = c || 0; }).catch((e) => { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; });
