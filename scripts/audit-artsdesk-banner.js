#!/usr/bin/env node
/**
 * BRO-7061 audit: theartsdesk.com review captures that still carry the support banner ("Help keep arts journalism
 * alive") or stop at an inline image's hidden "Image" label. Prints show/file, tier, word count and URL only (never
 * review text), so its output is safe to read from a public CI log.
 *
 * Usage: node scripts/audit-artsdesk-banner.js [--show=ID] [--year=2026] [--json] [--strict]
 *   --year=N   only files under show folders ending in -N or _pending/<...>-N (default: all years)
 *   --strict   exit 1 when any banner-prefixed or trailing-"Image" file is found (the re-audit gate)
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

const BANNER_RE = /^\s*help keep arts journalism alive/i;
const TRAILING_IMAGE_RE = /\bImage\s*$/;

function classify(d) {
  const text = String(d.fullText || '');
  return {
    banner: BANNER_RE.test(text),
    endsImage: TRAILING_IMAGE_RE.test(text),
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

function isArtsDeskFile(file, d) {
  return /^artsdesk--/.test(file) || /(?:^|\.)theartsdesk\.com$/i.test((() => { try { return new URL(d.url).hostname; } catch { return ''; } })());
}

function scan(root, { show, year } = {}) {
  const out = [];
  const dirs = show ? [show] : listShowDirs(root, { silent: true });
  // _pending holds one more level of show folders.
  const expanded = [];
  for (const s of dirs) {
    expanded.push(s);
    if (s === '_pending' && fs.existsSync(path.join(root, s))) {
      for (const c of fs.readdirSync(path.join(root, s))) expanded.push(path.join(s, c));
    }
  }
  for (const s of expanded) {
    if (year && !new RegExp(`-${year}$`).test(s)) continue;
    const dir = path.join(root, s);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!isArtsDeskFile(f, d)) continue;
      out.push({ show: s, file: f, contentTier: d.contentTier || null, url: d.url || null, ...classify(d) });
    }
  }
  return out;
}

if (require.main === module) {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const root = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(root)) { console.error(`review-texts dir not found: ${root}`); process.exit(2); }
  const rows = scan(root, { show: arg('show'), year: arg('year') });
  const bad = rows.filter((r) => r.banner || r.endsImage);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ total: rows.length, bad }, null, 2));
  else {
    for (const r of bad) console.log(`${r.show}/${r.file}  tier=${r.contentTier} words=${r.words} banner=${r.banner} endsImage=${r.endsImage}  ${r.url || ''}`);
    console.log(`artsdesk audit: ${rows.length} file(s), ${bad.length} with banner or trailing "Image", ${rows.filter((r) => r.banner).length} start with the banner`);
  }
  if (process.argv.includes('--strict') && rows.some((r) => r.banner || r.endsImage)) process.exit(1);
}

module.exports = { classify, scan, BANNER_RE };
