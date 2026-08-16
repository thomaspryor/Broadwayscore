#!/usr/bin/env node
/**
 * check-font-integrity.js — guard the font wiring at the SOURCE level.
 *
 * WHY THIS EXISTS (2026-08-16 incident)
 * -------------------------------------
 * Production shipped every page in Times New Roman and nothing noticed.
 *
 *   - next/font/google names its class `__variable_<hash>`, where
 *     hash = sha1(the CSS Google Fonts returns at build time)
 *     (next-font-loader/index.js:90).
 *   - Google's Inter response drifts, and `.next/cache` is persisted across
 *     deploys (vercel-deploy.yml), so the JS module and the emitted CSS asset
 *     could come from different loader runs.
 *   - Shipped HTML said `class="__variable_b9631e"`; shipped CSS only defined
 *     `.__variable_d0be19{--font-inter:...}`.
 *   - `--font-inter` was therefore undefined, and a bare `var()` with no
 *     fallback makes the WHOLE `font-family` declaration invalid at
 *     computed-value time. CSS does not skip to the next family — the property
 *     takes its INITIAL value. Every page rendered serif.
 *
 * The fix removed both halves of that: Inter is self-hosted with literal
 * @font-face names, and the Tailwind stack uses literal family names with no
 * var() at all. This script stops either half from creeping back, and checks
 * that the font filename — deliberately duplicated across globals.css,
 * layout.tsx and the file on disk — stays in agreement.
 *
 * WHY SOURCE-LEVEL AND NOT A BUILD-OUTPUT GATE
 * -------------------------------------------
 * The first version of this script parsed `.vercel/output/static`. That does
 * not work for this app: App Router pages are emitted as prerender functions
 * (`.vercel/output/functions/**.prerender-fallback.html`), not static HTML —
 * live app routes carry `vary: RSC, Next-Router-State-Tree` while
 * `/status.html` does not. `static/` does contain HTML, but only the 37
 * `public/og/*.html` templates, whose classes (`badge`, `bar`, `title`) have
 * nothing to do with the app shell. The gate would have gone green on
 * irrelevant HTML — a placebo — while risking a false positive that blocks the
 * only path that can ship the site. The real runtime assertion lives in
 * tests/e2e/smoke.spec.ts, which checks the computed font in a real browser
 * against production after every deploy.
 *
 * USAGE
 *   node scripts/check-font-integrity.js          # human-readable
 *   node scripts/check-font-integrity.js --json
 *   node scripts/check-font-integrity.js --help
 *
 * Exits 1 on any failure. Also consumed by tests/unit/font-integrity.test.mjs.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATHS = {
  root: process.cwd(),
  globalsCss: 'src/app/globals.css',
  tailwindConfig: 'tailwind.config.ts',
  layout: 'src/app/layout.tsx',
  publicDir: 'public',
  srcDir: 'src',
};

// Families that legitimately need no @font-face: CSS generics + OS-bundled.
const SYSTEM_FAMILIES = new Set(
  [
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
    'inherit', 'initial', 'unset', 'revert',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto',
    'helvetica neue', 'helvetica', 'arial', 'noto sans', 'liberation sans',
    'sfmono-regular', 'menlo', 'monaco', 'consolas', 'liberation mono',
    'courier new', 'times new roman', 'georgia', 'cambria', 'tahoma', 'verdana',
  ].map((s) => s.toLowerCase())
);

const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const normFamily = (raw) => raw.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();

/** Split a font stack on top-level commas so var(--a, "X, Y") stays intact. */
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Every @font-face in the CSS: family name + local src urls. */
function parseFontFaces(css) {
  const faces = [];
  const faceRe = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = faceRe.exec(css)) !== null) {
    const body = m[1];
    const fam = body.match(/font-family\s*:\s*([^;]+);?/);
    const srcs = [];
    const srcRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    let s;
    while ((s = srcRe.exec(body)) !== null) srcs.push(s[1]);
    if (fam) faces.push({ family: normFamily(fam[1]), srcs });
  }
  return faces;
}

/** The `sans:` array out of tailwind.config.ts fontFamily. */
function parseTailwindSans(ts) {
  const block = ts.match(/fontFamily\s*:\s*\{([\s\S]*?)\n\s{4}\}/);
  const scope = block ? block[1] : ts;
  const sans = scope.match(/sans\s*:\s*\[([\s\S]*?)\]/);
  if (!sans) return null;
  return sans[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^['"`]|['"`]$/g, ''));
}

function walk(dir, exts, out = [], depth = 0) {
  if (depth > 10) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, exts, out, depth + 1);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {object} [paths] override for tests; see DEFAULT_PATHS.
 * @returns {{failures: {check: string, detail: string}[], notes: string[]}}
 */
function analyze(paths = {}) {
  const p = { ...DEFAULT_PATHS, ...paths };
  const abs = (rel) => path.join(p.root, rel);
  const failures = [];
  const notes = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(abs(rel), 'utf8');
    } catch {
      failures.push({ check: 'missing-file', detail: `Expected ${rel} to exist.` });
      return null;
    }
  };

  const cssRaw = read(p.globalsCss);
  const tw = read(p.tailwindConfig);
  const layout = read(p.layout);
  if (cssRaw === null || tw === null || layout === null) return { failures, notes };

  const css = stripCssComments(cssRaw);
  const faces = parseFontFaces(css);
  const faceFamilies = new Set(faces.map((f) => f.family));
  notes.push(`@font-face families: ${[...faceFamilies].join(', ') || '(none)'}`);

  // 1. next/font must not come back — its class name is a hash of a live
  //    network response, which is what desynced HTML from CSS in the first place.
  for (const file of walk(abs(p.srcDir), ['.ts', '.tsx', '.js', '.jsx'])) {
    const body = stripJsComments(fs.readFileSync(file, 'utf8'));
    if (/from\s+['"]next\/font/.test(body) || /require\(\s*['"]next\/font/.test(body)) {
      failures.push({
        check: 'next-font-reintroduced',
        detail:
          `${path.relative(p.root, file)} imports next/font. Its generated class is ` +
          `__variable_<sha1(CSS Google returns at build time)>, so the HTML and the ` +
          `emitted CSS can disagree across a cached build — the 2026-08-16 serif ` +
          `incident. Use the self-hosted @font-face rules in ${p.globalsCss}.`,
      });
    }
  }

  // 2. The Tailwind sans stack must be literal names only.
  const sans = parseTailwindSans(tw);
  if (!sans || sans.length === 0) {
    failures.push({
      check: 'no-sans-stack',
      detail: `Could not parse a fontFamily.sans array from ${p.tailwindConfig}.`,
    });
  } else {
    notes.push(`tailwind sans[0]: ${sans[0]}`);
    for (const entry of sans) {
      if (entry.includes('var(')) {
        failures.push({
          check: 'var-in-font-stack',
          detail:
            `${p.tailwindConfig} fontFamily.sans contains "${entry}". If that custom ` +
            `property is ever undefined the ENTIRE font-family declaration becomes ` +
            `invalid at computed-value time and the browser uses its initial value ` +
            `(Times New Roman) — it does NOT fall through to the rest of this stack. ` +
            `Use a literal family name.`,
        });
      }
    }
    // 3. The primary family must actually be defined somewhere.
    const primary = normFamily(sans[0]);
    if (primary && !SYSTEM_FAMILIES.has(primary) && !faceFamilies.has(primary)) {
      failures.push({
        check: 'primary-family-undefined',
        detail:
          `"${sans[0]}" is first in the Tailwind sans stack but has no @font-face in ` +
          `${p.globalsCss} and is not an OS-bundled font, so it renders only for users ` +
          `who happen to have it installed.`,
      });
    }
  }

  // 4. Every @font-face src must exist on disk under public/.
  const declaredSrcs = new Set();
  for (const face of faces) {
    for (const src of face.srcs) {
      if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) {
        failures.push({
          check: 'remote-font-src',
          detail:
            `@font-face for "${face.family}" loads ${src} from a remote host. Fonts are ` +
            `self-hosted on purpose, and the CSP sets font-src 'self'.`,
        });
        continue;
      }
      declaredSrcs.add(src);
      const onDisk = path.join(abs(p.publicDir), src.replace(/^\//, ''));
      if (!fs.existsSync(onDisk)) {
        failures.push({
          check: 'missing-font-file',
          detail:
            `@font-face for "${face.family}" points at ${src}, which does not exist in ` +
            `${p.publicDir}/. Users would get a 404 and no font.`,
        });
      }
    }
  }

  // 5. The font filename is deliberately duplicated (globals.css, layout.tsx,
  //    the file itself) rather than derived — deriving it would reintroduce the
  //    indirection that caused the incident. So assert the copies agree.
  const preloads = [...stripJsComments(layout).matchAll(/['"](\/fonts\/[^'"]+\.woff2)['"]/g)].map(
    (m) => m[1]
  );
  if (preloads.length === 0) {
    failures.push({
      check: 'no-preload',
      detail:
        `${p.layout} references no /fonts/*.woff2 file. The first-paint subset should be ` +
        `preloaded, and losing the reference silently costs a round trip on every page.`,
    });
  }
  for (const href of preloads) {
    if (!declaredSrcs.has(href)) {
      failures.push({
        check: 'preload-mismatch',
        detail:
          `${p.layout} references ${href} but no @font-face in ${p.globalsCss} uses that ` +
          `exact file. The duplicated filename has drifted — the browser would preload a ` +
          `font it never uses (or 404).`,
      });
    }
  }

  return { failures, notes };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node scripts/check-font-integrity.js [--json]\n\n' +
        'Guards the self-hosted font wiring: no next/font imports, no var() in the\n' +
        'Tailwind sans stack, @font-face files present, preload href in sync.\n' +
        'Exits 1 on failure. See the header comment for the 2026-08-16 incident.'
    );
    process.exit(0);
  }

  const { failures, notes } = analyze();

  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  }

  for (const n of notes) console.log(`[font-integrity]   ${n}`);
  if (failures.length === 0) {
    console.log('[font-integrity] ✓ font wiring is intact');
    process.exit(0);
  }
  console.error(`\n[font-integrity] ✗ ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  [${f.check}] ${f.detail}\n`);
  console.error(
    '[font-integrity] The 2026-08-16 serif incident passed tsc, lint, the build and\n' +
      '[font-integrity] every deploy health check. Do not skip this.'
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { analyze, splitTopLevel, normFamily, parseFontFaces, parseTailwindSans };
