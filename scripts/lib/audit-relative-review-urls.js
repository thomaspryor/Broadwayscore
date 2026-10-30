#!/usr/bin/env node
/**
 * Audit review files whose `url` is not an absolute http(s) url (BRO-5075).
 * Prints counts per category and the deterministic fix for each fixable file.
 *
 *   node scripts/lib/audit-relative-review-urls.js [--root=data/review-texts] [--json] [--strict]
 *
 * --strict exits 1 when any non-absolute url remains. Exit 0 otherwise.
 * Categories and repairs: scripts/lib/relative-review-url.js.
 */
const fs = require('fs');
const path = require('path');
const { classifyRelativeUrl } = require('./relative-review-url');

function scan(root) {
  const rows = [];
  for (const show of fs.readdirSync(root)) {
    const dir = path.join(root, show);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
      const c = classifyRelativeUrl(j.url, j.outletId);
      if (c.category !== 'ok') rows.push({ file: `${show}/${f}`, outletId: j.outletId, url: j.url, ...c });
    }
  }
  return rows;
}

function main(argv) {
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
  const root = arg('root') || path.join(__dirname, '..', '..', 'data', 'review-texts');
  if (!fs.existsSync(root)) { console.error(`audit-relative-review-urls: ${root} missing (run ./scripts/setup-local-data.sh)`); return 2; }
  const rows = scan(root);
  const by = {};
  for (const r of rows) by[r.category] = (by[r.category] || 0) + 1;
  if (argv.includes('--json')) console.log(JSON.stringify({ total: rows.length, byCategory: by, rows }, null, 1));
  else console.log(`non-absolute review urls: ${rows.length} ${JSON.stringify(by)}`);
  return argv.includes('--strict') && rows.length > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scan, main };
