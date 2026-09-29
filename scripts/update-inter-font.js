#!/usr/bin/env node
/**
 * update-inter-font.js — refresh the self-hosted Inter subsets.
 *
 * Inter is self-hosted rather than pulled through next/font/google at build
 * time (see the @font-face block at the top of src/app/globals.css for the
 * 2026-08-16 incident that forced the change). That means updating it is a
 * deliberate, reviewable act instead of something Google can change under us
 * mid-deploy — which is the point.
 *
 * What it does:
 *   1. Asks Google Fonts for the Inter variable CSS with a woff2-capable UA.
 *   2. Downloads the latin + latin-ext subset files.
 *   3. Content-hashes each into public/fonts/Inter-<subset>-var.<hash>.woff2.
 *   4. Prints the exact @font-face blocks (with Google's own unicode-ranges)
 *      and the layout.tsx preload constant to paste in.
 *
 * It deliberately does NOT rewrite globals.css/layout.tsx itself: the whole
 * value of self-hosting is that the bytes and the CSS that names them change
 * together, in one reviewed commit.
 *
 *   node scripts/update-inter-font.js            # download + report
 *   node scripts/update-inter-font.js --check    # report drift, change nothing
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `update-inter-font.js — refresh the self-hosted Inter subsets from Google Fonts.

Downloads the latin + latin-ext variable subsets, content-hashes them into
public/fonts/, and prints the @font-face blocks and preload constant to paste
into src/app/globals.css and src/app/layout.tsx. It does not edit those files:
the bytes and the CSS naming them must change together in one reviewed commit.

Usage:
  node scripts/update-inter-font.js              download + report
  node scripts/update-inter-font.js --check      report drift, change nothing
  node scripts/update-inter-font.js --help, -h   print this usage and exit
`;
// --help/-h checked before any real work — this script fetches from the network
// and unlinks the superseded font files (see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

// 100..900, matching the `font-weight: 100 900` the @font-face rules declare.
// Google returns the same variable file for 400..900 today, but asking for a
// narrower axis than the CSS advertises means a future change on their side
// could quietly ship a font that cannot render the weights we claim.
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap';
// A woff2-capable desktop UA. Google serves ttf to unrecognised agents.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SUBSETS = ['latin', 'latin-ext'];
const OUT_DIR = path.join(process.cwd(), 'public', 'fonts');

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

function parseSubsets(css) {
  const out = {};
  // Google annotates each @font-face block with a /* subset */ comment.
  const blocks = css.split(/\/\*\s*([a-z-]+)\s*\*\//);
  for (let i = 1; i < blocks.length; i += 2) {
    const name = blocks[i];
    const body = blocks[i + 1] || '';
    const url = body.match(/url\((https:\/\/[^)]+\.woff2)\)/);
    const range = body.match(/unicode-range:\s*([^;]+);/);
    if (url && range) out[name] = { url: url[1], unicodeRange: range[1].trim() };
  }
  return out;
}

function wrapRange(range) {
  // Wrap long unicode-range lists so the emitted CSS stays readable.
  const items = range.split(/,\s*/);
  const lines = [];
  let line = '';
  for (const item of items) {
    if (line && (line + ', ' + item).length > 70) {
      lines.push(line + ',');
      line = item;
    } else {
      line = line ? line + ', ' + item : item;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? `  unicode-range: ${l}` : `    ${l}`)).join('\n') + ';';
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  const css = await (await get(CSS_URL)).text();
  const parsed = parseSubsets(css);

  const missing = SUBSETS.filter((s) => !parsed[s]);
  if (missing.length) {
    console.error(`[inter] Google's response is missing subset(s): ${missing.join(', ')}`);
    console.error(`[inter] Response was ${css.length} bytes — inspect before trusting it.`);
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [];
  const results = [];
  let changed = false;

  for (const subset of SUBSETS) {
    const { url, unicodeRange } = parsed[subset];
    const buf = Buffer.from(await (await get(url)).arrayBuffer());
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
    const filename = `Inter-${subset}-var.${hash}.woff2`;
    const current = existing.find((f) => f.startsWith(`Inter-${subset}-var.`));
    const isNew = current !== filename;
    if (isNew) changed = true;

    if (!checkOnly && isNew) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, filename), buf);
      // The superseded file is deliberately LEFT IN PLACE. globals.css and
      // layout.tsx still name it at this moment, so deleting it here would
      // leave the tree in a state where check-font-integrity.js fails and a
      // local build 404s — between this script finishing and a human pasting
      // the new blocks in. Remove it in the same commit that updates the CSS.
      if (current) {
        console.log(
          `[inter]   (left ${current} in place — delete it in the same commit that ` +
            `updates globals.css/layout.tsx, not before)`
        );
      }
    }

    results.push({ subset, filename, unicodeRange, bytes: buf.length, isNew, current });
    console.log(
      `[inter] ${subset}: ${buf.length} bytes -> ${filename}` +
        (isNew ? `  (CHANGED from ${current || 'nothing'})` : '  (unchanged)')
    );
  }

  if (!changed) {
    console.log('[inter] ✓ self-hosted files already match Google Fonts. Nothing to do.');
    return;
  }
  if (checkOnly) {
    console.log('\n[inter] Drift detected. Re-run without --check to download, then update:');
    console.log('[inter]   src/app/globals.css  (@font-face src + unicode-range)');
    console.log('[inter]   src/app/layout.tsx   (INTER_LATIN_WOFF2 preload constant)');
    process.exitCode = 1;
    return;
  }

  console.log('\n[inter] Files written. Paste these into src/app/globals.css:\n');
  for (const r of results) {
    console.log(`@font-face {
  font-family: 'InterVariable';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/${r.filename}') format('woff2');
${wrapRange(r.unicodeRange)}
}
`);
  }
  const latin = results.find((r) => r.subset === 'latin');

  // The metric-override fallback face describes ONE font file. If the woff2
  // changed, those numbers are now stale and the fallback is no longer
  // metric-matched — text will shift when the real font swaps in, and nothing
  // reports it because the page still renders. check-font-integrity.js fails on
  // the marker below, so the update cannot land half-done; say so here too,
  // where the person doing the update is actually looking.
  console.log(`[inter] ⚠ The fallback metrics in globals.css were computed for the PREVIOUS`);
  console.log(`[inter]   file and are now stale. Recompute them against the new woff2:\n`);
  console.log(`    node -e "
      const fontkit = require('next/dist/compiled/@next/font/dist/fontkit');
      const { getFallbackMetricsFromFontFile } =
        require('next/dist/compiled/@next/font/dist/local/get-fallback-metrics-from-font-file.js');
      const buf = require('fs').readFileSync('public/fonts/${latin.filename}');
      const mod = fontkit.default || fontkit;
      console.log(getFallbackMetricsFromFontFile(mod(buf), 'sans-serif'));
    "\n`);
  console.log(`[inter]   then update the @font-face for 'InterVariable Fallback' AND its`);
  console.log(`[inter]   marker comment to:\n`);
  console.log(` * metrics-for: /fonts/${latin.filename}\n`);

  console.log(`[inter] And in src/app/layout.tsx:\n`);
  console.log(`const INTER_LATIN_WOFF2 = '/fonts/${latin.filename}';\n`);
  console.log('[inter] Then: npm run build && node scripts/lib/check-font-integrity.js');
}

main().catch((e) => {
  console.error(`[inter] failed: ${e.message}`);
  process.exit(1);
});
