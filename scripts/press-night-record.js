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
 *                        Census = archived roundups plus the BWW roundup fetched live by this
 *                        script (BRO-6067: no other workflow had archived it by +2h). --label=end
 *                        also fills a missing +2h coverage from the record's live timeline.
 *   --import-lane-shadow=DIR  fold a lane-shadow artifact (opening-night-lane-live.yml) into the
 *                        record: finer site-live times and the first lane discovery (publish bound).
 *   --rebuild-reference  recompute +2h and end coverage from the live timeline against a census
 *                        built now (backfill for a night whose census was missing).
 *   --finalize           mark the probe ended and print a summary.
 *   --list-due           print the shows (--shows=a,b) whose probe should start now, one per line
 *   --check              verdict against the plan's gates from the committed record only
 *                        (public JSON, no private fields). Exit 0 PASS, 1 FAIL or UNKNOWN.
 *
 * Common: --show=ID --night=YYYY-MM-DD [--dir=data/audit/press-night] [--json]
 * Probe:  [--embargo-at=ISO] [--interval-min=5] [--until-offset-hours=6] [--base=URL]
 * Check:  [--first-live-within=30] [--coverage2h=0.8]
 * Census: [--bww-url=URL] [--no-fetch] (skip the live BWW roundup fetch)
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
  const rel = result.release;
  if (rel) {
    console.log(`[press-night] ${lib.releaseSourceLabel(rel)} (${rel.observedAt}) came ${rel.lateMin} min after the assumed embargo ${rel.assumedAt}; the verdict above uses the assumed embargo. Measured from the observed release: ${rel.observed.verdict}`);
    for (const g of rel.observed.gates) {
      console.log(`  ${g.status.toUpperCase().padEnd(7)} ${g.name}: ${g.detail}${g.required ? '' : ' (not required)'}`);
    }
  }
}

function listDue() {
  // Orchestrator hook: one "showId night market embargoAt" line per show whose probe should start now.
  const ids = String(arg('shows', '')).split(',').map((x) => x.trim()).filter(Boolean);
  const nowMs = arg('now') ? new Date(arg('now')).getTime() : Date.now();
  if (!ids.length || !Number.isFinite(nowMs)) { console.error('[press-night] --list-due needs --shows=a,b and a valid --now'); return 2; }
  for (const id of ids) {
    const show = loadShow(id);
    // stderr: the orchestrator reads stdout line by line as "show night market embargo".
    const problem = lib.embargoOverrideProblem(show);
    if (problem) console.error(`::warning::${id}: ${problem}; using the market default embargo`);
    const due = lib.probeDue(show, nowMs);
    if (due) console.log(`${due.showId} ${due.night} ${due.market} ${due.embargoAt}`);
  }
  return 0;
}

/**
 * BRO-6614: when the lane found the first review well after the assumed embargo, also judge +2h coverage
 * from the observed release (reference['2h-observed']) against the same census, so --check can grade the
 * night both ways. Removed again if the release no longer looks late.
 */
function setObservedReference(rec, census, { fetchedAt, excluded, note }) {
  const rel = lib.observedRelease(rec);
  if (!rel) { delete rec.reference['2h-observed']; return; }
  const obsMs = new Date(rel.observedAt).getTime();
  rec.reference['2h-observed'] = { ...lib.coverageAt({ ...rec, embargoAt: rel.observedAt }, census, obsMs + 2 * 3600000, { fetchedAt, excluded, deferLateSeen: true }), censusNote: note };
  const r = rec.reference['2h-observed'];
  console.log(`[press-night] reference 2h-observed (release ${rel.observedAt}, as of ${r.asOf}): ${r.status}${r.coverage != null ? ` coverage=${r.coverage} (${r.covered}/${r.count})` : ''}`);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function findFiles(dir, pred, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Read a downloaded lane-shadow artifact (any layout) for this show-night. */
function readLaneShadow(dir, showId, night) {
  const report = findFiles(dir, (p) => path.basename(p) === 'shadow-report.json')[0];
  const live = findFiles(dir, (p) => path.basename(p) === 'live-first-seen.jsonl')[0];
  const ledger = findFiles(dir, (p) => path.basename(p) === `${showId}-${night}.jsonl`)[0];
  if (!report && !live) return null;
  let rep = null;
  try { rep = report ? JSON.parse(fs.readFileSync(report, 'utf8')) : null; } catch (_) { rep = null; }
  if (rep && (rep.show !== showId || rep.night !== night)) throw new Error(`lane shadow is for ${rep.show} ${rep.night}, not ${showId} ${night}`);
  return { report: rep, liveRows: live ? readJsonl(live) : [], ledgerRows: ledger ? readJsonl(ledger) : [] };
}

/**
 * Census for the record: archived roundups, plus the BWW roundup fetched live when the archive has
 * none (BRO-6067: the probe waited for another workflow to archive it and read no-census-yet all night).
 * Returns {census, note}.
 */
/**
 * Snapshot the show's review-text files (public-safe rows) into the record and return the census
 * outlets the rebuild keeps off the site (BRO-6070). Without private review texts it keeps any earlier
 * snapshot and returns what that snapshot excludes, never "nothing excluded".
 */
function stampFileState(rec, show, census) {
  const state = require('./lib/press-night-review-state');
  const read = show ? state.readReviewFileState(rec.showId, show) : { available: false, files: [] };
  if (read.available) rec.fileState = { capturedAt: new Date().toISOString(), files: read.files };
  const files = rec.fileState && rec.fileState.files;
  if (!files) console.log('[press-night] review-texts not available: census exclusions and same-night-completeness stay unknown');
  const g = lib.DEFAULT_GATES;
  const embMs = new Date(rec.embargoAt).getTime();
  const opts = Number.isFinite(embMs) ? { windowStartMs: embMs - g.nightStartH * 3600000, night: rec.night } : {};
  return files ? state.censusExclusions(census, files, opts) : [];
}

async function buildCensus(rec, show) {
  const { buildCensusFromArchives, unionCensus, parseBwwRoundup } = require('./lib/review-census');
  const market = rec.market || 'broadway';
  const archive = buildCensusFromArchives(rec.showId, { market, show: show || undefined });
  const nyc = ['broadway', 'off-broadway', 'nyc'].includes(market);
  if (!nyc || has('no-fetch') || archive.sourcesPresent.includes('bww-roundup') || !show) return { census: archive, note: 'archive only' };
  let url = arg('bww-url') || (rec.laneShadow && rec.laneShadow.bwwRoundupUrl) || null;
  try {
    if (!url) {
      const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover');
      const found = await discoverBwwRoundupUrl(show);
      url = found && found.url;
    }
    if (!url) return { census: archive, note: 'no BWW roundup found' };
    const { fetchPage } = require('./lib/scraper');
    const page = await fetchPage(url);
    const html = page && page.content;
    if (!html) return { census: archive, note: `BWW roundup fetch empty: ${url}` };
    const { verifyAggregatorUrl } = require('./lib/show-match-verifier');
    const v = verifyAggregatorUrl({ url, html, show, openingDate: show.openingDate });
    if (!v.isValid && v.rejectReason !== 'no-significant-title-tokens') return { census: archive, note: `BWW roundup rejected (${v.rejectReason}): ${url}` };
    const rows = parseBwwRoundup(html, rec.showId);
    if (!rows.length) return { census: archive, note: `BWW roundup parsed 0 reviews: ${url}` };
    const merged = unionCensus([{ source: 'archive', reviews: archive.entries }, { source: 'bww-roundup-live', reviews: rows }]);
    merged.sourcesPresent = [...archive.sourcesPresent, 'bww-roundup-live'];
    merged.bwwRoundupUrl = url;
    return { census: merged, note: `archive + live BWW roundup (${rows.length} rows): ${url}` };
  } catch (e) {
    return { census: archive, note: `BWW roundup fetch failed: ${String(e.message || e).slice(0, 160)}` };
  }
}

function hasCoverage(ref) { return !!(ref && ref.coverage != null); }

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
      const embargoSource = show && show.openingDate === night ? lib.classifyEmbargo(show, embargoAt) : 'manual';
      rec = lib.emptyRecord({ showId, night, market, embargoAt, embargoSource, intervalMin: Number(arg('interval-min', 5)) });
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

  if (arg('import-lane-shadow') != null) {
    const dirArg = arg('import-lane-shadow');
    if (!dirArg) { console.error('[press-night] --import-lane-shadow=DIR required'); return 2; }
    let parsed;
    try { parsed = readLaneShadow(path.resolve(dirArg), showId, night); } catch (e) { console.error(`[press-night] ${e.message}`); return 1; }
    if (!parsed) { console.log(`[press-night] no lane-shadow files under ${dirArg}; record unchanged`); return 0; }
    rec.laneShadow = lib.laneShadowFrom({ ...parsed, importedAt: new Date().toISOString(), runId: arg('run-id') });
    writeRecord(file, rec);
    const ls = rec.laneShadow;
    console.log(`[press-night] lane shadow imported: ${ls.liveFirstSeen.length} site-live rows, first discovery ${ls.firstDiscoveredAt || 'none'}, BWW roundup ${ls.bwwRoundupUrl || 'none'}`);
    return 0;
  }

  if (has('rebuild-reference')) {
    const show = loadShow(showId);
    const { census, note } = await buildCensus(rec, show);
    const excluded = stampFileState(rec, show, census);
    const fetchedAt = new Date().toISOString();
    const embMs = new Date(rec.embargoAt).getTime();
    const endMs = new Date(rec.probe.lastOkSampleAt || rec.probe.lastSampleAt).getTime();
    for (const [label, asOfMs] of [['2h', embMs + 2 * 3600000], ['end', endMs]]) {
      if (!Number.isFinite(asOfMs)) continue;
      if (rec.reference[label] && !rec.reference[`${label}-live`] && rec.reference[label].method !== 'timeline') rec.reference[`${label}-live`] = rec.reference[label];
      rec.reference[label] = { ...lib.coverageAt(rec, census, asOfMs, { fetchedAt, excluded, deferLateSeen: label === '2h' }), censusNote: note };
    }
    setObservedReference(rec, census, { fetchedAt, excluded, note });
    writeRecord(file, rec);
    for (const label of ['2h', 'end']) {
      const r = rec.reference[label];
      if (r) console.log(`[press-night] reference ${label} (timeline, as of ${r.asOf}): ${r.status}${r.coverage != null ? ` coverage=${r.coverage} (${r.covered}/${r.count})` : ''}`);
    }
    console.log(`[press-night] census: ${note}`);
    return 0;
  }

  if (has('capture-reference')) {
    const label = arg('label');
    if (!['2h', 'end'].includes(label)) { console.error('[press-night] --label=2h|end required'); return 2; }
    const fetchedAt = new Date().toISOString();
    let ref;
    let census = null;
    let note = '';
    let excluded = [];
    try {
      const { decodeSlimShow } = require('./show-status');
      const prod = await fetchProdJson(showId, base);
      const liveCount = decodeSlimShow(prod).reviews.length;
      const { censusVerdict } = require('./lib/review-census');
      const { deployedOutletIds } = require('./lib/deployed-coverage-diff');
      const show = loadShow(showId);
      ({ census, note } = await buildCensus(rec, show));
      excluded = stampFileState(rec, show, census);
      const kept = lib.filterCensus(census, excluded);
      ref = { ...lib.referenceFrom({ census: kept, verdict: censusVerdict(kept, deployedOutletIds(prod)), liveCount, fetchedAt }), censusNote: note, ...(excluded.length ? { excluded } : {}) };
    } catch (e) {
      ref = { status: 'error', error: String(e.message || e).slice(0, 200), source: null, count: 0, covered: null, coverage: null, missing: [], fetchedAt };
    }
    rec.reference[label] = ref;
    // The +2h census was missing (roundup not out or not fetchable then), or thinner than this one: judge +2h
    // on the live timeline against this later, fuller census (a bigger denominator is the stricter answer).
    const ref2 = rec.reference['2h'];
    const keptCount = census ? lib.filterCensus(census, excluded).count : 0;
    const exKey = (x) => JSON.stringify((x || []).map((e) => e.outletId).sort());
    if (label === 'end' && census && census.count && (!hasCoverage(ref2) || keptCount > (ref2.count || 0) || exKey(ref2 && ref2.excluded) !== exKey(excluded))) {
      if (rec.reference['2h'] && !rec.reference['2h-live']) rec.reference['2h-live'] = rec.reference['2h'];
      rec.reference['2h'] = { ...lib.coverageAt(rec, census, new Date(rec.embargoAt).getTime() + 2 * 3600000, { fetchedAt, excluded, deferLateSeen: true }), censusNote: note };
      console.log(`[press-night] reference 2h filled from the live timeline: ${rec.reference['2h'].status} coverage=${rec.reference['2h'].coverage}`);
    }
    if (label === 'end' && census && census.count) setObservedReference(rec, census, { fetchedAt, excluded, note });
    writeRecord(file, rec);
    console.log(`[press-night] reference ${label}: ${ref.status}${ref.coverage != null ? ` coverage=${ref.coverage} (${ref.covered}/${ref.count})` : ''}${note ? `; census: ${note}` : ''}`);
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
