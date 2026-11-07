#!/usr/bin/env node

/**
 * Report-only sweep (BRO-5805): review files excluded by wrongProduction /
 * wrongShow whose stored body names most of THIS show's listed cast. The
 * verifier that raised the flag has no cast list; cast overlap is evidence the
 * text is about this production (scripts/lib/own-show-text-evidence.js). A hit
 * is a candidate for hand adjudication, not proof the flag is wrong: the same
 * cast can appear in a transfer or tour that the date and market guards
 * rightly exclude, so read `wrongProductionReason` before clearing.
 *
 * Skips files a person already ruled on (manual-clear markers). No --fix, by
 * design: a clear re-admits the review into live Critic Scores.
 *
 * Usage:
 *   node scripts/audit-excluded-with-own-show-evidence.js [--json] [--show=ID]
 *     [--gate --max=N] [--review-texts-dir=PATH] [--shows-path=PATH]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { ownShowTextEvidence } = require('./lib/own-show-text-evidence.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const ROOT = path.resolve(__dirname, '..');
const MANUAL_CLEAR = ['wrongProductionManualClear', 'wrongShowManualClear', 'wrongProductionOverride', 'allowCrossMarket', 'allowEarlyDate'];

function flagged(data) {
  const out = [];
  if (data.wrongProduction === true) out.push('wrongProduction');
  if (data.wrongShow === true) out.push('wrongShow');
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  const max = parseMaxArgOrExit(argv, { scriptName: 'audit-excluded-with-own-show-evidence' });
  const val = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const reviewDir = val('review-texts-dir') || path.join(ROOT, 'data', 'review-texts');
  const showsPath = val('shows-path') || path.join(ROOT, 'data', 'shows.json');
  const only = val('show');

  const showsById = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    for (const s of (Array.isArray(parsed) ? parsed : parsed.shows) || []) if (s && s.id) showsById[s.id] = s;
  } catch { /* vacuity check below */ }
  if (Object.keys(showsById).length === 0) {
    console.error(`FAIL: no show records loaded from ${showsPath}.`);
    process.exit(gate ? 1 : 3);
  }

  let showDirs = [];
  try { showDirs = listShowDirs(reviewDir, { silent: true }); } catch { showDirs = []; }
  try {
    assertCorpusScanned(showDirs.length, { gate: true });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(gate ? 1 : 3);
  }

  const hits = [];
  for (const showId of showDirs) {
    if (only && showId !== only) continue;
    const show = showsById[showId];
    if (!show) continue;
    const dir = path.join(reviewDir, showId);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const file of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const flags = flagged(data);
      if (!flags.length || MANUAL_CLEAR.some((f) => data[f] === true)) continue;
      const ev = ownShowTextEvidence(data.fullText, show);
      if (!ev.strong) continue;
      hits.push({
        showId, file, flags, castHits: ev.castHits.length, castListed: ev.castListed,
        reason: String(data.wrongProductionReason || data.wrongShowReason || '').slice(0, 120) || null,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, hits }, null, 2));
  } else {
    console.log(`Excluded-with-own-show-evidence sweep: ${showDirs.length} shows scanned, ${hits.length} candidate(s).`);
    for (const h of hits) {
      console.log(`  [${h.flags.join('+')}] ${h.showId}/${h.file}  cast ${h.castHits}/${h.castListed}  ${h.reason || '(no reason recorded)'}`);
    }
  }
  if (gate && hits.length > max) {
    console.error(`FAIL: ${hits.length} excluded review(s) name the show's own cast (> max ${max}).`);
    process.exit(1);
  }
}

main();
