#!/usr/bin/env node
/**
 * flag-legacy-web-search-rows.js — mark the rows the deleted LLM 'web-search'
 * step invented (url never served the review, no fetched text) with
 * fabricatedEntry, so the gap engine looks for the REAL link (URL_FIND, via
 * text-gap-classify NO_URL/INVENTED_URL) instead of fetching the invented url,
 * and the rebuild stops scoring the step's own excerpt. BRO-7171.
 *
 * Evidence rule: scripts/lib/legacy-web-search.js legacyWebSearchFlagPatch
 * (no url, or 404/410 / url_dead on the stored url, and no fetched text).
 * Only open gap rows are considered. --probe sends ONE free GET to each
 * never-fetched row's url that has no dead evidence yet; a 404/410 counts
 * (and is stamped as httpStatus), anything else (200, 403, timeout) does not.
 *
 * Usage:
 *   node scripts/flag-legacy-web-search-rows.js            # dry run, prints counts
 *   node scripts/flag-legacy-web-search-rows.js --probe    # dry run + status probe
 *   node scripts/flag-legacy-web-search-rows.js --probe --apply   # write + checkpoint push
 *   --show=SLUG   one show only;  --json  print the per-file list
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROBE = args.includes('--probe');
const AS_JSON = args.includes('--json');
const SHOW = (args.find((a) => a.startsWith('--show=')) || '').slice(7) || null;

async function probeStatus(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
    clearTimeout(t);
    return r.status;
  } catch { return null; }
}

async function main() {
  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const { listShowDirs } = require('./lib/list-show-dirs');
  const { isLegacyWebSearchOnly, legacyWebSearchFlagPatch } = require('./lib/legacy-web-search');
  const { classifyTextGap } = require('./lib/text-gap-classify');
  const { effectiveFailureReason } = require('./lib/failed-fetch-policy');
  const dir = resolveReviewTextsDir();
  let ff = new Map();
  try {
    ff = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'failed-fetches.json'), 'utf8'))
      .map((e) => [String(e.filePath || '').replace(/^data\/review-texts\//, ''), e]));
  } catch { /* no failed-fetches file */ }

  const shows = SHOW ? [SHOW] : listShowDirs(dir, { silent: true });
  const plan = [];
  const stats = { wsOnlyUnflagged: 0, open: 0, flag: 0, byEvidence: {}, probed: 0, probeStatuses: {}, notFlaggedOpen: {} };
  for (const show of shows) {
    const sd = path.join(dir, show);
    let files; try { files = fs.readdirSync(sd).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const filePath = path.join(sd, f);
      let d; try { d = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (!isLegacyWebSearchOnly(d) || d.fabricatedEntry === true || d.fabricatedEntry === false) continue;
      stats.wsOnlyUnflagged++;
      const key = `${show}/${f}`;
      const e = ff.get(key) || null;
      const g = classifyTextGap(d, e, { nowMs: Date.now() });
      if (!g.open) continue;
      stats.open++;
      const ffReason = e ? effectiveFailureReason(e) : '';
      let patch = legacyWebSearchFlagPatch(d, { ffReason });
      let probe = null;
      if (!patch && PROBE && d.url && d.contentTier !== 'complete') {
        probe = await probeStatus(d.url);
        stats.probed++;
        stats.probeStatuses[probe] = (stats.probeStatuses[probe] || 0) + 1;
        patch = legacyWebSearchFlagPatch(d, { ffReason, probeStatus: probe });
      }
      if (!patch) { stats.notFlaggedOpen[g.gapClass] = (stats.notFlaggedOpen[g.gapClass] || 0) + 1; continue; }
      const ev = patch.fabricatedReason.replace(/^.*?\):\s*/, '').split(',')[0];
      stats.byEvidence[ev.replace(/\d{3}/, 'NNN')] = (stats.byEvidence[ev.replace(/\d{3}/, 'NNN')] || 0) + 1;
      stats.flag++;
      plan.push({ key, filePath, url: d.url || null, gapClass: g.gapClass, patch, stampStatus: (probe === 404 || probe === 410) && d.httpStatus !== probe ? probe : null });
    }
  }

  if (AS_JSON) console.log(JSON.stringify(plan.map(({ filePath, ...r }) => r), null, 1));
  console.log(JSON.stringify(stats, null, 1));
  if (!APPLY) { console.log(`DRY RUN: ${plan.length} row(s) would be flagged. Re-run with --apply to write.`); return; }

  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const { readReviewForUpdate, persistReviewSnapshot } = require('./lib/persist-review-snapshot');
  const { checkpointReviewTexts, createWriteTracker } = require('./lib/review-texts-checkpoint');
  const tracker = createWriteTracker();
  let wrote = 0;
  for (const p of plan) {
    withReviewTextsLock(`flag-legacy-web-search:${p.key}`, () => {
      const data = readReviewForUpdate(p.filePath);
      if (data.fabricatedEntry === true || data.fabricatedEntry === false || (data.url || null) !== p.url) return; // changed since the scan
      Object.assign(data, p.patch, { fabricatedFlaggedAt: new Date().toISOString() });
      if (p.stampStatus) data.httpStatus = p.stampStatus;
      persistReviewSnapshot({ filePath: p.filePath, data, trailingNewline: true });
      tracker.add(path.resolve(p.filePath));
      wrote++;
    });
  }
  console.log(`wrote ${wrote} file(s)`);
  if (!tracker.size) return;
  const res = checkpointReviewTexts({ // takes the review-texts lock itself
    repoDir: dir, paths: [...tracker], expected: tracker.expected,
    message: `data: flag ${wrote} invented-url legacy web-search rows (fabricatedEntry) for URL_FIND (BRO-7171)`,
    meta: { source: 'flag-legacy-web-search-rows' },
  });
  console.log(`[checkpoint] ${res.pushed ? 'pushed' : 'nothing to push'}; ${res.landed.length} file(s) confirmed on origin/main`);
}

main().catch((e) => { console.error(e); process.exit(1); });
