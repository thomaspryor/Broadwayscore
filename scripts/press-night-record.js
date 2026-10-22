#!/usr/bin/env node
'use strict';

/**
 * press-night-record.js — measure one press night end to end (BRO-5912).
 *
 * Modes (one per call):
 *   --probe              sample the deployed show JSON every --interval-min until
 *                        --until (ISO) or --until-offset-hours past the embargo; resumes
 *                        from the record file if it exists. One long-running job, no cron.
 *   --capture-reference  stamp census coverage vs the deployed JSON as of now
 *                        (--label=2h|end). Needs data/aggregator-archive; without it the
 *                        label reads no-census-yet (unknown, never a pass).
 *   --finalize           mark the probe ended and print a summary.
 *   --list-due           print the shows (--shows=a,b) whose probe should start now, one per line
 *   --check              verdict against the plan's gates from the committed record only
 *                        (public JSON, no private fields). Exit 0 PASS, 1 FAIL or UNKNOWN.
 *
 * Common: --show=ID --night=YYYY-MM-DD [--dir=data/audit/press-night] [--json]
 * Probe:  [--embargo-at=ISO] [--interval-min=5] [--until-offset-hours=6] [--base=URL]
 * Check:  [--first-live-within=30] [--coverage2h=0.8]
 *
 * Reuses decodeSlimShow + dedupByCritic identity from verify-opening-night-live.js,
 * deployedOutletIds from lib/deployed-coverage-diff.js and the census from
 * lib/review-census.js. Pure decisions live in lib/press-night-record.js.
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib/press-night-record');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join('data', 'audit', 'press-night');
const DEFAULT_BASE = 'https://broadwayscorecard.com/data/shows';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const has = (n) => args.includes(`--${n}`);

function usage() {
  console.log('Usage: node scripts/press-night-record.js --show=ID --night=YYYY-MM-DD (--probe | --capture-reference --label=2h|end | --finalize | --check) [--dir=DIR] [--json]\nSee the header of this file for the options of each mode.');
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeRecord(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function fetchProdJson(showId, base) {
  const res = await fetch(`${base}/${showId}.json`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadShow(showId) {
  try {
    const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows;
    return shows.find((s) => (s.id || s.slug) === showId) || null;
  } catch (_) { return null; }
}

function printVerdict(result, asJson, rec) {
  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }
  const where = rec ? `${rec.showId} ${rec.night}` : 'no record';
  console.log(`[press-night] ${where}: ${result.verdict}`);
  for (const g of result.gates) {
    console.log(`  ${g.status.toUpperCase().padEnd(7)} ${g.name}: ${g.detail}${g.required ? '' : ' (not required)'}`);
  }
}

function listDue() {
  // Orchestrator hook: one "showId night market embargoAt" line per show whose probe should start now.
  const ids = String(arg('shows', '')).split(',').map((x) => x.trim()).filter(Boolean);
  const nowMs = arg('now') ? new Date(arg('now')).getTime() : Date.now();
  if (!ids.length || !Number.isFinite(nowMs)) { console.error('[press-night] --list-due needs --shows=a,b and a valid --now'); return 2; }
  for (const id of ids) {
    const due = lib.probeDue(loadShow(id), nowMs);
    if (due) console.log(`${due.showId} ${due.night} ${due.market} ${due.embargoAt}`);
  }
  return 0;
}

async function main() {
  if (hasHelpFlag(args)) { usage(); return 0; }
  if (has('list-due')) return listDue();
  const showId = arg('show');
  const night = arg('night');
  if (!showId || !night || !/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    console.error('[press-night] --show=ID and --night=YYYY-MM-DD are required');
    usage();
    return 2;
  }
  const dir = path.resolve(ROOT, arg('dir', DEFAULT_DIR));
  const file = lib.recordPath(dir, showId, night);
  const base = arg('base', DEFAULT_BASE);

  if (has('check')) {
    const rec = readRecord(file);
    const gates = {};
    if (arg('first-live-within')) gates.firstLiveWithinMin = Number(arg('first-live-within'));
    if (arg('coverage2h')) gates.coverage2h = Number(arg('coverage2h'));
    if (Object.values(gates).some((v) => !Number.isFinite(v))) { console.error('[press-night] --first-live-within and --coverage2h must be numbers'); return 2; }
    const result = lib.evaluateCheck(rec, gates);
    printVerdict(result, has('json'), rec);
    return result.verdict === 'PASS' ? 0 : 1;
  }

  if (has('probe')) {
    const { decodeSlimShow } = require('./show-status');
    const show = loadShow(showId);
    const embargoAt = arg('embargo-at') || (show && show.openingDate === night ? lib.defaultEmbargoAt(show) : null);
    let rec = readRecord(file);
    if (!rec) {
      if (!embargoAt) { console.error('[press-night] no --embargo-at, and shows.json has no entry opening on --night to derive one'); return 2; }
      const market = arg('market') || (show ? show.category : null);
      if (!market) { console.error('[press-night] market unknown: pass --market=broadway|west-end'); return 2; }
      rec = lib.emptyRecord({ showId, night, market, embargoAt, intervalMin: Number(arg('interval-min', 5)) });
    } else if (arg('embargo-at') && new Date(arg('embargo-at')).getTime() !== new Date(rec.embargoAt).getTime()) {
      console.error(`[press-night] record already has embargo ${rec.embargoAt}; refusing to resume with --embargo-at=${arg('embargo-at')}`);
      return 2;
    }
    const intervalMs = Number(arg('interval-min', rec.probe.intervalMin || 5)) * 60000;
    const untilMs = arg('until')
      ? new Date(arg('until')).getTime()
      : new Date(rec.embargoAt).getTime() + Number(arg('until-offset-hours', 6)) * 3600000;
    if (!Number.isFinite(untilMs)) { console.error('[press-night] bad --until / embargo'); return 2; }
    console.log(`[press-night] probing ${showId} every ${intervalMs / 60000} min until ${new Date(untilMs).toISOString()} (embargo ${rec.embargoAt})`);
    const samplesBefore = rec.probe.samples;
    await lib.runProbe({
      rec,
      fetchReviews: async () => decodeSlimShow(await fetchProdJson(showId, base)).reviews,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      untilMs,
      intervalMs,
      maxSamples: Number(arg('max-samples', Infinity)),
      onSample: (r) => {
        writeRecord(file, r);
        console.log(`[press-night] ${r.probe.lastSampleAt} live=${r.liveCount} samples=${r.probe.samples} failed=${r.probe.failedSamples}`);
      },
    });
    writeRecord(file, rec);
    if (rec.probe.samples === samplesBefore) { console.log('[press-night] no sample was due (window already past)'); return 0; }
    return rec.probe.samples - rec.probe.failedSamples > 0 ? 0 : 1; // 1 = every fetch failed
  }

  const rec = readRecord(file);
  if (!rec) { console.error(`[press-night] no record at ${path.relative(ROOT, file)}`); return 1; }

  if (has('capture-reference')) {
    const label = arg('label');
    if (!['2h', 'end'].includes(label)) { console.error('[press-night] --label=2h|end required'); return 2; }
    const fetchedAt = new Date().toISOString();
    let ref;
    try {
      const { decodeSlimShow } = require('./show-status');
      const prod = await fetchProdJson(showId, base);
      const liveCount = decodeSlimShow(prod).reviews.length;
      const { buildCensusFromArchives, censusVerdict } = require('./lib/review-census');
      const { deployedOutletIds } = require('./lib/deployed-coverage-diff');
      const show = loadShow(showId);
      const census = buildCensusFromArchives(showId, { market: rec.market || 'broadway', show: show || undefined });
      ref = lib.referenceFrom({ census, verdict: censusVerdict(census, deployedOutletIds(prod)), liveCount, fetchedAt });
    } catch (e) {
      ref = { status: 'error', error: String(e.message || e).slice(0, 200), source: null, count: 0, covered: null, coverage: null, missing: [], fetchedAt };
    }
    rec.reference[label] = ref;
    writeRecord(file, rec);
    console.log(`[press-night] reference ${label}: ${ref.status}${ref.coverage != null ? ` coverage=${ref.coverage} (${ref.covered}/${ref.count})` : ''}`);
    return ref.status === 'error' ? 1 : 0;
  }

  if (has('finalize')) {
    rec.probe.endedAt = new Date().toISOString();
    rec.firstOutletPublishAt = lib.firstOutletPublish(rec);
    writeRecord(file, rec);
    printVerdict(lib.evaluateCheck(rec), has('json'), rec);
    return 0;
  }

  usage();
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error('[press-night] fatal:', e.stack || e.message); process.exit(1); });
