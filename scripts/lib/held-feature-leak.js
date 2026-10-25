#!/usr/bin/env node
/**
 * Held-feature leak guard (BRO-5007). The Box Office / Commercial v3 work is
 * hidden behind `commercial && boxOfficeV2`, both prod-held. Gating the render
 * is not enough: a 'use client' module that is statically imported ships its
 * copy in the route's JS chunk whatever the flags say, and the source-reading
 * tests in tests/unit/commercial-unreleased.test.mjs cannot see bundles.
 *
 * Two parts:
 * - isHeldSource(): which source files belong to the held feature. A file is
 *   held when its path matches HELD_PATHS or it carries the `@held-feature`
 *   marker, so a new file is covered without editing a list.
 * - scanBuildOutput(): reads a built site (out/, .next/static or
 *   .vercel/output/static) and reports every SENTINEL found. Each sentinel is
 *   copy that only held source files contain (the unit test enforces that), so
 *   any hit in a flag-off build is a leak.
 *
 * CLI: node scripts/lib/held-feature-leak.js <build dir> [--warn]
 * Exit 1 on a hit (0 with --warn), 2 when the directory is missing or empty.
 */
const fs = require('fs');
const path = require('path');

// Copy that exists only in held source files. Add the new section's own
// wording here when you add a held section; the unit test fails if a sentinel
// is missing from held files or appears in a public one.
const SENTINELS = [
  'covering their costs',
  'Covering its weekly break-even',
  'Is it covering its costs',
  'Most money per seat',
  'How the new musicals are selling',
  'Dollars at the time, not adjusted for inflation',
  'judged only against their own run',
];

const HELD_PATHS = [
  /^src\/components\/BoxOffice(Scorecard|V\d)[^/]*\.tsx$/,
  /^src\/components\/WeeklyBarChart\.tsx$/,
  /^src\/components\/box-office\//,
  /^src\/components\/biz\/BreakEvenSection[^/]*\.tsx$/,
  /^src\/lib\/box-office-(v2-)?display\.ts$/,
];
const HELD_MARKER = /@held-feature\b/;

// A *Lazy.tsx wrapper only holds the dynamic() call; it carries no copy and is
// what public modules import, so it is not itself held.
function isHeldSource(rel, text = '') {
  const p = rel.split(path.sep).join('/');
  if (/Lazy\.tsx$/.test(p)) return false;
  return HELD_PATHS.some((re) => re.test(p)) || HELD_MARKER.test(text);
}

const SCANNED = /\.(html|js|txt|json|rsc)$/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : SCANNED.test(d.name) ? [p] : [];
  });
}

/** Returns { files, hits: [{ file, sentinel }] } for a built output directory. */
function scanBuildOutput(dir, sentinels = SENTINELS) {
  const files = walk(dir);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const s of sentinels) if (text.includes(s)) hits.push({ file: path.relative(dir, file), sentinel: s });
  }
  return { files: files.length, hits };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const warn = args.includes('--warn');
  if (!dir || !fs.existsSync(dir)) {
    console.error(`held-feature-leak: build directory not found: ${dir || '(none given)'}`);
    process.exit(2);
  }
  const { files, hits } = scanBuildOutput(dir);
  if (files === 0) {
    console.error(`held-feature-leak: no html/js files under ${dir}`);
    process.exit(2);
  }
  if (hits.length === 0) {
    console.log(`held-feature-leak: OK, ${files} files, no held copy`);
    process.exit(0);
  }
  for (const h of hits.slice(0, 50)) console.log(`${warn ? '::warning::' : '::error::'}held copy "${h.sentinel}" in ${h.file}`);
  console.log(`held-feature-leak: ${hits.length} hit(s) in ${files} files`);
  process.exit(warn ? 0 : 1);
}

module.exports = { SENTINELS, HELD_PATHS, isHeldSource, scanBuildOutput };
