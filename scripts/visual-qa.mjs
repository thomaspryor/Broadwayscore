#!/usr/bin/env node
// scripts/visual-qa.mjs — local multi-width screenshot sweep + optional two-model LLM review
//
// Forcing function for visual QA. Run before pushing UI changes so the agent
// (and the user) can SEE the change at multiple breakpoints + at full pixel
// resolution. The companion hook (.claude/hooks/pre-push-visual-gate.sh)
// requires `.claude/visual-qa/<branch>/verdict.json` newer than the latest
// UI edit OR an explicit `APPROVED: <verdictHash>` from the user before any
// push touching src/**/*.{tsx,jsx,css,scss} can proceed.
//
// CLI:
//   --url <required>            localhost URL of the running dev server
//   --paths <comma-sep>         routes to capture (default "/")
//   --elements <css-selectors>  comma-separated selectors to crop at full size per viewport
//   --refs <paths|"none">       comma-separated reference images for LLM review (or omit)
//   --branch <name>             defaults to current git branch
//   --out <dir>                 defaults to .claude/visual-qa/<branch>/
//
// Exit codes: 0 success/PASS, 1 bad args, 2 dev-server unreachable / LLM FAIL
//
// See sprint-plan-visual-qa-gate.md and .claude/skills/visual-qa/skill.md.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const WIDTHS = [360, 414, 768, 1024, 1440];

function parseArgs(argv) {
  const args = {
    url: null,
    paths: ['/'],
    elements: [],
    refs: null,
    branch: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq >= 0) {
      key = a.slice(0, eq).replace(/^--/, '');
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = argv[++i];
    } else {
      continue;
    }
    if (key === 'url') args.url = val;
    else if (key === 'paths') args.paths = val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'elements') args.elements = val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'refs') args.refs = val === 'none' ? null : val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'branch') args.branch = val;
    else if (key === 'out') args.out = val;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/visual-qa.mjs --url=<localhost-url> [options]

Required:
  --url <url>               localhost URL of the dev server (https://, file://, prod
                            URLs are rejected — gate is "local preview before push")

Options:
  --paths <a,b,c>           comma-separated routes; default "/"
  --elements <sel,sel>      CSS selectors to crop at full pixel resolution per viewport.
                            Use this for anything the agent needs to legibility-check
                            (a thumbnail-Read of a 5-width full-page screenshot is the
                            silent-PASS root cause).
  --refs <path,path|none>   reference design images for LLM diff review (GPT-4o + Gemini).
                            Omit OR pass "none" to skip LLM review (structural-only verdict).
  --branch <name>           git branch (defaults to current). Used in output dir naming.
  --out <dir>               output directory (defaults to .claude/visual-qa/<branch>/)

Widths swept (fixed): ${WIDTHS.join(', ')}

Exit codes:
  0  success / overall PASS
  1  bad args
  2  dev server unreachable OR LLM review returned FAIL OR localhost-only violation
`);
}

function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim() || 'no-branch';
  } catch {
    return 'no-branch';
  }
}

function slugify(s) {
  return s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
}

async function captureWithRetry(page, attempts, action, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await action(); }
    catch (err) {
      lastErr = err;
      console.error(`[visual-qa] ${label} attempt ${i + 1} failed: ${err?.message}`);
    }
  }
  throw lastErr;
}

// In-browser overflow probe: returns selectors for elements whose content
// is clipped horizontally or vertically by their box. Catches the FeaturedSpot
// "HISTORICAL ACCURA" silent failure (one-line pill in a constrained grid
// column with whitespace-nowrap on long text).
//
// The +1 tolerance absorbs sub-pixel rounding; the parent-overflow:hidden
// guard scopes to clipping the user would actually SEE (not internal
// scroll-containers that are scrollable by design).
function overflowProbeScript() {
  const PROBE = () => {
    const out = [];
    const seen = new Set();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const sw = el.scrollWidth, cw = el.clientWidth;
      const sh = el.scrollHeight, ch = el.clientHeight;
      const xClip = sw > cw + 1;
      const yClip = sh > ch + 1;
      if (!xClip && !yClip) continue;
      if (el === document.body || el === document.documentElement) continue;

      const cs = getComputedStyle(el);

      // Skip screen-reader-only (sr-only): clientWidth/Height ≤ 4 means the
      // element is intentionally hidden visually but kept in DOM for a11y.
      if (cw <= 4 && ch <= 4) continue;
      // Skip invisible / display-none
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // Skip clip-path-based sr-only (skip-to-content links and similar).
      // The CSS `clip` property is deprecated but still used; `clip-path` is modern.
      if (cs.clip && cs.clip !== 'auto' && cs.clip !== 'none') continue;
      if (cs.clipPath && cs.clipPath !== 'none') continue;

      // Skip intentional text-truncate (overflow content rendered as ellipsis
      // is a design choice, not a bug). Check self AND parent — Tailwind's
      // `truncate` puts overflow:hidden on the element + text-overflow:ellipsis.
      const selfEllipsis = cs.textOverflow === 'ellipsis' && (cs.overflowX === 'hidden' || cs.overflowX === 'clip');
      if (selfEllipsis) continue;

      // Skip if the immediate parent is a scroll container (overflow-x:auto/scroll)
      // — that's a carousel/scroller pattern where content > viewport is the design.
      const parent = el.parentElement;
      if (parent) {
        const pcs = getComputedStyle(parent);
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') continue;
        if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll') continue;
      }

      // Determine if the element is actually clipped (parent overflow:hidden
      // or self overflow:hidden / clip), vs. legitimately scrollable.
      const overflowX = cs.overflowX;
      const overflowY = cs.overflowY;
      const selfClips = overflowX === 'hidden' || overflowX === 'clip' || overflowY === 'hidden' || overflowY === 'clip';
      let ancestorClips = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'hidden' || pcs.overflowX === 'clip' || pcs.overflowY === 'hidden' || pcs.overflowY === 'clip') {
          ancestorClips = true; break;
        }
      }
      if (!selfClips && !ancestorClips) continue;
      // Build a short selector path
      function shortSel(node) {
        if (!node || node.nodeType !== 1) return '';
        let s = node.tagName.toLowerCase();
        if (node.id) s += '#' + node.id;
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) s += '.' + cls;
        }
        return s;
      }
      const path = [];
      let cur = el;
      while (cur && cur !== document.body && path.length < 4) {
        path.unshift(shortSel(cur));
        cur = cur.parentElement;
      }
      const sel = path.join(' > ');
      if (seen.has(sel)) continue;
      seen.add(sel);
      const text = (el.textContent || '').trim().slice(0, 60);
      out.push({
        selector: sel,
        xClip,
        yClip,
        scrollWidth: sw,
        clientWidth: cw,
        scrollHeight: sh,
        clientHeight: ch,
        textPreview: text,
      });
      if (out.length >= 25) break; // cap report size
    }
    return out;
  };
  return `(${PROBE.toString()})()`;
}

async function captureScreenshots({ url, paths, branch, outDir, elements }) {
  const browser = await chromium.launch();
  const screenshots = [];
  const elementCrops = [];
  const overflowReport = [];
  try {
    for (const path of paths) {
      const pathSlug = slugify(path);
      for (const width of WIDTHS) {
        const dir = join(outDir, pathSlug);
        mkdirSync(dir, { recursive: true });
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        try {
          await captureWithRetry(page, 2, async () => {
            await page.goto(url + path, { waitUntil: 'load', timeout: 15000 });
            // Belt-and-suspenders: 'load' fires when network requests for the
            // initial HTML resolve, but client-side hydration may still be
            // running. 'networkidle' is deprecated/flaky in Playwright so we
            // use a small fixed wait instead.
            await page.waitForTimeout(2000);
          }, `goto ${path} @ ${width}`);

          const file = join(dir, `${width}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshots.push({ path, width, file });

          // Structural overflow probe — runs in the page, fast (<200ms typical).
          try {
            const clipped = await page.evaluate(overflowProbeScript());
            for (const item of clipped) {
              overflowReport.push({ path, viewport: width, ...item });
            }
          } catch (err) {
            console.error(`[visual-qa] WARN: overflow probe failed at ${path} @ ${width}: ${err?.message}`);
          }

          for (const sel of elements) {
            try {
              const locator = page.locator(sel).first();
              if (await locator.count() === 0) {
                console.error(`[visual-qa] WARN: element "${sel}" not found at ${path} @ ${width}`);
                continue;
              }
              const cropFile = join(dir, `${width}__${slugify(sel)}.png`);
              await locator.screenshot({ path: cropFile });
              elementCrops.push({ path, width, selector: sel, file: cropFile });
            } catch (err) {
              console.error(`[visual-qa] WARN: crop failed for "${sel}" @ ${width}: ${err?.message}`);
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return { screenshots, elementCrops, overflowReport };
}

function isLocalhost(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function devServerReachable(url) {
  // Health check: dev server must respond with >1KB HTML. Catches the
  // "Playwright happily captures a blank page as PASS" failure mode.
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.text();
    if (body.length < 1024) return { ok: false, reason: `response too small (${body.length} bytes)` };
    if (!/<html|<!doctype/i.test(body)) return { ok: false, reason: 'response not HTML' };
    return { ok: true, bytes: body.length };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.url) {
    console.error('ERROR: --url is required.\nRun with --help for usage.');
    process.exit(1);
  }

  if (!isLocalhost(args.url)) {
    console.error(`ERROR: --url must be a localhost URL (got "${args.url}").
The gate enforces "show it to me locally first" — prod URLs do not count
as local preview. Start the dev server (\`npm run dev\`) and use http://localhost:3000.`);
    process.exit(2);
  }

  const health = await devServerReachable(args.url);
  if (!health.ok) {
    console.error(`ERROR: dev server not reachable at ${args.url}: ${health.reason}.
Start it first:  npm run dev
Then re-run this command.`);
    process.exit(2);
  }

  const branch = args.branch || getCurrentBranch();
  const outDir = args.out || `.claude/visual-qa/${branch}`;

  console.error(`[visual-qa] url=${args.url} branch=${branch} paths=${args.paths.join(',')} widths=${WIDTHS.join(',')} elements=${args.elements.length} refs=${args.refs ? args.refs.length : 'none'}`);
  console.error(`[visual-qa] out=${outDir}`);
  console.error(`[visual-qa] dev server OK (${health.bytes} bytes HTML)`);

  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const { screenshots, elementCrops, overflowReport } = await captureScreenshots({
    url: args.url, paths: args.paths, branch, outDir, elements: args.elements,
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.error(`[visual-qa] captured ${screenshots.length} full-page + ${elementCrops.length} element crop(s) + ${overflowReport.length} overflow finding(s) in ${elapsed}s`);
  if (overflowReport.length > 0) {
    console.error('[visual-qa] OVERFLOW FINDINGS:');
    for (const o of overflowReport.slice(0, 10)) {
      const axes = [o.xClip ? `xClip(sw=${o.scrollWidth},cw=${o.clientWidth})` : null, o.yClip ? `yClip(sh=${o.scrollHeight},ch=${o.clientHeight})` : null].filter(Boolean).join(' ');
      console.error(`  - ${o.viewport}px ${o.path} ${o.selector} ${axes} text="${o.textPreview}"`);
    }
  }
  // LLM review + verdict.json come in S1-T5..T6.
  process.exit(0);
}

main().catch(err => {
  console.error(`[visual-qa] FATAL: ${err?.stack || err}`);
  process.exit(2);
});
