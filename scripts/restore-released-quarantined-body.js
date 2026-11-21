#!/usr/bin/env node
'use strict';
/**
 * restore-released-quarantined-body.js (BRO-2851): put a quarantined review
 * body back into fullText once its wrong-content verdict was released by a
 * human or an override, when the live fullText is missing or a shorter copy of
 * the same article. Rules: scripts/lib/quarantine-body.js
 * releasedBodyRestoreVerdict.
 *
 * Usage:
 *   node scripts/restore-released-quarantined-body.js --scan [--max=N]
 *   node scripts/restore-released-quarantined-body.js --file=<showId>/<file>.json [--apply]
 * --scan lists candidates; exit 1 when more than --max (default 0). Daily in
 * check-corpus-drift.js. --file checks one record and, with --apply, writes it
 * (allowlisted for approved-fix run-script plans). Exit 1 when the record does
 * not qualify, so a plan action fails loudly.
 */
const fs = require('fs');
const path = require('path');
const { releasedBodyRestoreVerdict, restoreReleasedBody } = require('./lib/quarantine-body');
const { isGarbageContent, classifyContentTier } = require('./lib/content-quality');
const { textsShareVerbatimPassage } = require('./lib/review-text-identity');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `restore-released-quarantined-body.js — restore a released quarantined review body
Usage:
  node scripts/restore-released-quarantined-body.js --scan [--max=N]
  node scripts/restore-released-quarantined-body.js --file=<showId>/<file>.json [--apply]
`;
const DEPS = {
  isGarbage: (t) => isGarbageContent(t).isGarbage,
  sameArticle: (a, b) => textsShareVerbatimPassage(a, b),
};

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const root = arg('dir') || path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(root)) { console.error(`review-texts missing at ${root}`); return 3; }

  if (argv.includes('--scan')) {
    const max = arg('max') != null ? parseInt(arg('max'), 10) : 0;
    const hits = [];
    for (const showId of fs.readdirSync(root)) {
      if (showId.startsWith('_') || showId.startsWith('.')) continue;
      const dir = path.join(root, showId);
      let files;
      try { if (!fs.statSync(dir).isDirectory()) continue; files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (typeof d.wrongFullText !== 'string') continue;
        const v = releasedBodyRestoreVerdict(d, DEPS);
        if (v.ok) hits.push(`${showId}/${f}: ${v.reason} (live ${(d.fullText || '').length} chars, quarantined ${d.wrongFullText.length})`);
      }
    }
    console.log(`${hits.length} released review(s) with the full body still quarantined (max ${max})`);
    for (const h of hits) console.log(`  ${h}`);
    if (hits.length) console.log('Fix: read the quarantined text; if it is this review, approved-fix run-script restore-released-quarantined-body.js --file=<show>/<file> --apply');
    return hits.length > max ? 1 : 0;
  }

  const rel = arg('file');
  if (!rel || rel.includes('..')) { console.error(USAGE); return 2; }
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) { console.error(`not found: ${rel}`); return 1; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const v = releasedBodyRestoreVerdict(data, DEPS);
  if (!v.ok) { console.error(`REFUSED ${rel}: ${v.reason}`); return 1; }
  restoreReleasedBody(data, classifyContentTier);
  console.log(`${argv.includes('--apply') ? 'RESTORED' : 'WOULD RESTORE'} ${rel}: ${v.reason}; contentTier ${data.contentTier}, ${data.wordCount} words`);
  if (argv.includes('--apply')) {
    const { safeWriteReview } = require('./lib/review-write-guard');
    const res = safeWriteReview(fp, data);
    if (res && res.wrote === false) { console.error(`write refused: ${JSON.stringify(res)}`); return 1; }
  }
  return 0;
}

if (require.main === module) process.exit(main());
