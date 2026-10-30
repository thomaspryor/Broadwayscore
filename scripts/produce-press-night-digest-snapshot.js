#!/usr/bin/env node
/**
 * produce-press-night-digest-snapshot.js — "Last night's openings" for the owner's morning email
 * (BRO-6645). One plain-English line per show that had a press night last night (New York date):
 * reviews live on time (the press-night record, scripts/lib/press-night-record.js) and the opening-night
 * emails ready (Resend draft current with the live numbers, Reddit draft emailed). Rules and wording:
 * scripts/lib/press-night-digest.js.
 *
 * Writes data/audit/press-night-digest-snapshot.json, read by scripts/send-morning-digest.js through the
 * digest-snapshots.js registry (key pressNight). With --file-cards every miss opens a fix card through
 * linear-brain.js create --dispatch (P1 for a late or missing review, P2 for an email draft miss), once per
 * show-night: data/audit/press-night-fix-cards.json is the ledger, so a re-run never files twice and a new
 * miss on a filed show-night becomes a comment on its card. Cards are only filed for finished records.
 *
 * Runs hourly in opening-night-checklist.yml, after the press-night probe has committed the record.
 *
 *   node scripts/produce-press-night-digest-snapshot.js [--night=YYYY-MM-DD] [--now=ISO] [--file-cards] [--dry-run]
 *
 * --dry-run prints the section and the cards it would file; writes nothing, files nothing.
 * Kill switch for filing: PRESS_NIGHT_FIX_CARDS_DISABLED=true.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('./lib/press-night-digest');
const { readShowNumbers } = require('./lib/broadcast-refresh');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO = process.env.PRESS_NIGHT_ROOT || path.join(__dirname, '..');
const SNAPSHOT = path.join(REPO, 'data', 'audit', 'press-night-digest-snapshot.json');
const LEDGER = path.join(REPO, 'data', 'audit', 'press-night-fix-cards.json');
// Cards start with the 2026-10-30 press night: the Oct 29 misses (A Few Good Men, The Heart) were already
// being worked under the press-night coordinator card BRO-5955 when this landed, so a first run must not
// dispatch duplicate workers onto them. The email lines still cover every night.
const FIRST_FILING_NIGHT = '2026-10-30';

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

function loadInputs(night) {
  const dir = path.join(REPO, 'data', 'audit', 'press-night');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(`-${night}.json`)).sort(); } catch { files = []; }
  const records = files.map((f) => {
    const rec = readJson(path.join(dir, f), null);
    return { showId: rec && rec.showId ? rec.showId : f.slice(0, -`-${night}.json`.length), rec };
  });
  const raw = readJson(path.join(REPO, 'data', 'shows.json'), []);
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const sentShows = (readJson(path.join(REPO, 'data', 'opening-night-sent.json'), {}) || {}).shows || {};
  const redditDrafts = (readJson(path.join(REPO, 'data', 'audit', 'reddit-post-drafts.json'), {}) || {}).drafts || {};
  const showsDir = path.join(REPO, 'public', 'data', 'shows');
  return { records, shows, sentShows, redditDrafts, readNumbers: (id) => readShowNumbers(id, showsDir) };
}

/** Snapshot shape for the renderer: the lines plus counts. Names only, no ids (the owner reads it). */
function toSnapshot(section) {
  const count = (v) => section.entries.filter((e) => e.verdict === v).length;
  return {
    generatedAt: section.generatedAt,
    night: section.night,
    counts: { total: section.entries.length, passed: count('PASS'), failed: count('FAIL'), notGraded: count('UNKNOWN') + count('PENDING') },
    lines: section.entries.map((e) => ({ verdict: e.verdict, line: e.line })),
  };
}

function linearBrain(args) {
  return execFileSync(process.execPath, [path.join(__dirname, 'linear-brain.js'), ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120000 });
}

async function createCard({ title, notes, priority }) {
  const out = linearBrain(['create', title, '--notes', notes, '--dispatch', '--priority', String(priority === 1 ? 2 : 3), '--model', 'opus', '--source', 'press-night-digest']);
  const m = /"identifier"\s*:\s*"([A-Z]+-\d+)"/.exec(out);
  if (!m) throw new Error(`linear-brain create printed no identifier: ${out.slice(0, 300)}`);
  return m[1];
}

async function commentCard(identifier, text) {
  linearBrain(['update', identifier, '--comment', text]);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const dryRun = argv.includes('--dry-run');
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (!Number.isFinite(nowMs)) { console.error('--now must be an ISO time'); return 2; }
  const night = arg('night') || D.lastNight(nowMs);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) { console.error('--night must be YYYY-MM-DD'); return 2; }

  const section = D.buildSection({ night, nowMs, ...loadInputs(night) });
  const snap = toSnapshot(section);
  console.log(`Last night's openings (${night}):`);
  for (const l of snap.lines) console.log(`  [${l.verdict}] ${l.line}`);
  if (!snap.lines.length) console.log('  (no press nights)');
  if (!dryRun) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + '\n');
    console.log(`wrote ${path.relative(REPO, SNAPSHOT)}`);
  }

  if (!argv.includes('--file-cards')) return 0;
  if (process.env.PRESS_NIGHT_FIX_CARDS_DISABLED === 'true') { console.log('fix cards: disabled (PRESS_NIGHT_FIX_CARDS_DISABLED=true)'); return 0; }
  if (night < FIRST_FILING_NIGHT) { console.log(`fix cards: none for ${night}, filing starts with the ${FIRST_FILING_NIGHT} night`); return 0; }
  // Only finished records file cards: a probe still sampling can still turn a miss into a pass.
  const graded = { ...section, entries: section.entries.filter((e) => e.verdict !== 'PENDING') };
  const ledger = readJson(LEDGER, { cards: {} });
  if (dryRun) {
    const would = await D.fileFixCards({ section: graded, ledger: JSON.parse(JSON.stringify(ledger)),
      createCard: async (c) => { console.log(`  would file: ${c.title}`); return 'DRY-RUN'; },
      commentCard: async (id) => { console.log(`  would comment on ${id}`); } });
    console.log(`fix cards (dry run): ${would.filed.length} new, ${would.commented.length} comments, ${would.skipped.length} already filed`);
    return 0;
  }
  // Checkpoint the ledger after every card, so a crash between two filings cannot re-file the first.
  const save = () => fs.writeFileSync(LEDGER, JSON.stringify({ updatedAt: new Date().toISOString(), cards: ledger.cards || {} }, null, 2) + '\n');
  const res = await D.fileFixCards({
    section: graded, ledger,
    createCard: async (c) => { const id = await createCard(c); ledger.cards = ledger.cards || {}; return id; },
    commentCard,
    onFiled: save,
  });
  save();
  console.log(`fix cards: filed ${res.filed.join(', ') || 'none'}; commented ${res.commented.join(', ') || 'none'}; already filed ${res.skipped.length}`);
  for (const e of res.errors) console.error(`::warning::press-night fix card failed: ${e}`);
  return res.errors.length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { toSnapshot, loadInputs };
