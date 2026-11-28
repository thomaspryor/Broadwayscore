#!/usr/bin/env node
/**
 * Read-only acceptance check for scripts/lib/gap-acceptance.js (BRO-7171
 * Stage 1): replay real candidate pairs from the review-texts repo through the
 * OLD gate (processRecoveredText as it exists in --old-helpers, run against a
 * temp copy) and the NEW gate (acceptRecoveredText, pure), and print the
 * accept/reject lists plus every disagreement.
 *
 * Pairs:
 *   recovered   a past "<Outlet> browser recovery" commit: existing = the file
 *               at the commit's parent, candidate = the recovered fullText.
 *   cross-show  an unrecovered (non-complete) file of the outlet, candidate =
 *               another show's recovered text from the same outlet (the
 *               wrong-show class the gate must refuse).
 *   same-text   an unrecovered file re-fed its own stored text.
 *   serp-url    a file SERP rediscovery moved to a new url (identity proof).
 *
 * Never writes to the review-texts repo: the old gate runs on copies under a
 * temp dir. Usage:
 *   node scripts/gap-acceptance-dryrun.js [--repo=PATH] [--per-outlet=7]
 *     [--old-helpers=PATH] [--json]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
if (args.includes('--help')) {
  console.log('Usage: node scripts/gap-acceptance-dryrun.js [--repo=PATH] [--per-outlet=7] [--old-helpers=PATH] [--json]');
  process.exit(0);
}
const REPO = arg('repo', path.join(os.homedir(), 'broadway-review-texts'));
const PER_OUTLET = parseInt(arg('per-outlet', '7'), 10);
const OLD_HELPERS = arg('old-helpers', path.join(os.homedir(), 'Broadwayscore', 'scripts', 'lib', 'browser-recovery-helpers.js'));

const { acceptRecoveredText, buildAcceptanceContext } = require('./lib/gap-acceptance');

function git(...a) {
  return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
function gitJson(rev, rel) {
  try { return JSON.parse(git('show', `${rev}:${rel}`)); } catch { return null; }
}

const OUTLETS = [
  { id: 'thestage', grep: 'The Stage browser recovery', sourceMethod: 'thestage-subscriber-recovery-login' },
  { id: 'wsj', grep: 'WSJ browser recovery', sourceMethod: 'wsj-subscriber-recovery-otp-login' },
];

function recoveredPairs(outlet) {
  const commits = git('log', '--format=%H', `--grep=${outlet.grep}`).split('\n').filter(Boolean);
  const pairs = [];
  for (const c of commits) {
    const files = git('show', '--name-only', '--format=', c).split('\n')
      .filter((f) => f.endsWith('.json') && path.basename(f).startsWith(`${outlet.id}--`));
    for (const rel of files) {
      const after = gitJson(c, rel);
      const before = gitJson(`${c}^`, rel);
      if (!after || !before || after.sourceMethod !== outlet.sourceMethod) continue;
      if (before.sourceMethod === outlet.sourceMethod || before.fullText === after.fullText) continue;
      pairs.push({ kind: 'recovered', outlet: outlet.id, rel, commit: c.slice(0, 11), existing: before, rawText: after.fullText });
      if (pairs.length >= PER_OUTLET) return pairs;
    }
  }
  return pairs;
}

function listFiles(prefix) {
  const out = [];
  for (const d of fs.readdirSync(REPO)) {
    if (d.startsWith('_') || d.startsWith('.')) continue;
    let files;
    try { files = fs.readdirSync(path.join(REPO, d)); } catch { continue; }
    for (const f of files) if (f.startsWith(`${prefix}--`) && f.endsWith('.json')) out.push(`${d}/${f}`);
  }
  return out.sort();
}

function readRel(rel) { try { return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')); } catch { return null; } }

function negativePairs(outlet, donors) {
  const pairs = [];
  const files = listFiles(outlet.id);
  const open = files.map((rel) => ({ rel, d: readRel(rel) }))
    .filter((x) => x.d && x.d.contentTier !== 'complete' && !x.d.wrongShow && !x.d.wrongProduction && x.d.url);
  const donor = donors.find((p) => p.outlet === outlet.id);
  for (const x of open) {
    if (!donor || pairs.length >= 2) break;
    if (x.rel.split('/')[0] === donor.rel.split('/')[0]) continue;
    pairs.push({ kind: 'cross-show', outlet: outlet.id, rel: x.rel, existing: x.d, rawText: donor.rawText, donor: donor.rel });
  }
  const withText = open.filter((x) => (x.d.fullText || '').length >= 300);
  if (withText.length) pairs.push({ kind: 'same-text', outlet: outlet.id, rel: withText[0].rel, existing: withText[0].d, rawText: withText[0].d.fullText });
  return pairs;
}

function serpPairs() {
  const out = [];
  for (const d of fs.readdirSync(REPO)) {
    if (d.startsWith('_') || d.startsWith('.')) continue;
    let files;
    try { files = fs.readdirSync(path.join(REPO, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rel = `${d}/${f}`;
      const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
      if (!raw.includes('"serp-text-recovery-serp-rediscovery"')) continue;
      const cur = JSON.parse(raw);
      if (!cur.previousUrl) continue;
      // Pre-recovery record: same excerpts/critic, the old url, no recovered text.
      const existing = { ...cur, url: cur.previousUrl, fullText: '', contentTier: 'stub' };
      delete existing.previousUrl;
      out.push({ kind: 'serp-url', outlet: f.split('--')[0], rel, existing, rawText: cur.fullText, newUrl: cur.url });
    }
  }
  return out;
}

function runOld(pair, tmpRoot) {
  if (pair.newUrl) return { ok: null, reason: 'n/a (old SERP gate moved the url first; not replayable)' };
  let helpers;
  try { helpers = require(OLD_HELPERS); } catch (e) { return { ok: null, reason: `old helpers unavailable: ${e.message}` }; }
  const filePath = path.join(tmpRoot, pair.rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(pair.existing, null, 2) + '\n');
  const showId = pair.existing.showId || pair.rel.split('/')[0];
  const quiet = console.log; console.log = () => {};
  try {
    return helpers.processRecoveredText({ filePath, showId, url: pair.existing.url }, pair.rawText,
      { fetchMethod: 'dryrun', sourceMethod: 'dryrun', contentTierReasonFallback: 'dryrun' });
  } catch (e) {
    return { ok: false, reason: `threw: ${e.message}` };
  } finally { console.log = quiet; }
}

function runNew(pair, tmpRoot) {
  const filePath = path.join(tmpRoot, 'new', pair.rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bl = path.join(REPO, pair.rel.split('/')[0], '_blocklist.json');
  if (fs.existsSync(bl)) fs.copyFileSync(bl, path.join(path.dirname(filePath), '_blocklist.json'));
  const ctx = buildAcceptanceContext(filePath, pair.existing, pair.newUrl, { reviewTextsDir: REPO });
  return acceptRecoveredText(pair.existing, { rawText: pair.rawText, url: pair.newUrl }, ctx);
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-dryrun-'));
  const pairs = [];
  for (const o of OUTLETS) {
    const rec = recoveredPairs(o);
    pairs.push(...rec, ...negativePairs(o, rec));
  }
  pairs.push(...serpPairs());

  const rows = pairs.map((p) => {
    const oldR = runOld(p, tmpRoot);
    const newR = runNew(p, tmpRoot);
    return { kind: p.kind, rel: p.rel, commit: p.commit, donor: p.donor,
      old: oldR.ok === null ? 'n/a' : (oldR.ok ? 'ACCEPT' : 'REJECT'), oldReason: oldR.ok ? '' : oldR.reason,
      neu: newR.accept ? 'ACCEPT' : 'REJECT', newCode: newR.code, newReason: newR.reason };
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`gap-acceptance dry-run: ${rows.length} real candidate pairs from ${REPO} (read-only)\n`);
  for (const r of rows) {
    const flag = r.old === 'n/a' ? '   ' : (r.old === r.neu ? ' = ' : ' ≠ ');
    console.log(`${flag}${r.kind.padEnd(10)} old=${r.old.padEnd(6)} new=${r.neu.padEnd(6)} ${r.rel}${r.donor ? ` (text from ${r.donor})` : ''}`);
    if (r.neu === 'REJECT') console.log(`      new: [${r.newCode}] ${r.newReason}`);
    if (r.old === 'REJECT') console.log(`      old: ${r.oldReason}`);
  }
  const accepted = rows.filter((r) => r.neu === 'ACCEPT').length;
  const newRefusals = rows.filter((r) => r.old === 'ACCEPT' && r.neu === 'REJECT');
  const newAccepts = rows.filter((r) => r.old === 'REJECT' && r.neu === 'ACCEPT');
  console.log(`\nNEW gate: ${accepted} accept / ${rows.length - accepted} reject`);
  console.log(`New refusals vs old (${newRefusals.length}):`);
  for (const r of newRefusals) console.log(`  - ${r.rel}: [${r.newCode}] ${r.newReason}`);
  console.log(`New acceptances vs old (${newAccepts.length}):`);
  for (const r of newAccepts) console.log(`  - ${r.rel}: old refused "${r.oldReason}"`);
}

main();
