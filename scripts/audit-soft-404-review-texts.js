#!/usr/bin/env node
/**
 * Backfill scan for BRO-3116: review-text files whose fullText is a soft-404
 * template, or whose body is byte-identical to another critic's in the same
 * show. Report-only; the collector re-fetches these via its soft_404 guard.
 *
 * Usage: node scripts/audit-soft-404-review-texts.js [--show=ID] [--json]
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isSoft404Body, findDuplicateBodies } = require('./lib/soft-404-body');

const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const showArg = (process.argv.find((a) => a.startsWith('--show=')) || '').slice(7);
const asJson = process.argv.includes('--json');

const shows = showArg ? [showArg] : listShowDirs(ROOT, { silent: true });
const findings = [];
for (const show of shows) {
  const dir = path.join(ROOT, show);
  if (!fs.existsSync(dir)) continue;
  const entries = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      entries.push({ file: f, fullText: d.fullText, url: d.url });
    } catch (e) { /* skip unreadable */ }
  }
  const flagged = new Map();
  for (const e of entries) if (isSoft404Body(e.fullText)) flagged.set(e.file, { reason: 'not-found-signature', url: e.url });
  for (const g of findDuplicateBodies(entries)) {
    for (const f of g) if (!flagged.has(f)) flagged.set(f, { reason: `identical-body x${g.length}`, url: (entries.find((e) => e.file === f) || {}).url });
  }
  for (const [file, info] of flagged) findings.push({ show, file, ...info });
}

if (asJson) console.log(JSON.stringify(findings, null, 2));
else {
  for (const f of findings) console.log(`${f.show}/${f.file}  [${f.reason}]  ${f.url || ''}`);
  console.log(`soft-404 audit: ${findings.length} file(s) across ${shows.length} show(s)`);
}
