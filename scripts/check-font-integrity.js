#!/usr/bin/env node
/**
 * check-font-integrity.js — post-build gate: does the site actually have its font?
 *
 * WHY THIS EXISTS (2026-08-16 incident)
 * -------------------------------------
 * Production shipped every page in Times New Roman for an unknown length of
 * time and nothing noticed. The mechanism:
 *
 *   - next/font/google names its generated class `__variable_<hash>`, where
 *     hash = sha1(the CSS Google Fonts returns at build time).
 *   - Google's Inter response drifts, so two loader runs can yield two hashes.
 *   - `.next/cache` is restored across deploys (vercel-deploy.yml), so the JS
 *     module and the emitted CSS asset could come from *different* runs.
 *   - Result: HTML had `class="__variable_b9631e"`, CSS defined only
 *     `.__variable_d0be19{--font-inter:...}`.
 *   - `--font-inter` was therefore undefined, which makes the whole
 *     `font-family: var(--font-inter), Inter, ...` declaration invalid at
 *     computed-value time. CSS does NOT skip to the next family in that case —
 *     the property falls back to its *initial* value. Every page rendered serif.
 *
 * Every existing gate passed: tsc, lint, the build itself, and the deploy
 * health checks. All of them look at source or at HTTP status; none looked at
 * whether the shipped CSS and the shipped HTML agreed. This does.
 *
 * CHECKS
 *   1. undefined-var       — a font-family uses var(--x) and no CSS defines --x.
 *   2. unreachable-var     — --x is defined, but only under selectors whose
 *                            classes never appear in any shipped HTML (the
 *                            exact 2026-08-16 hash-mismatch shape).
 *   3. var-without-fallback— a font-family uses bare var(--x); one undefined
 *                            property silently poisons the entire stack.
 *                            Write var(--x, Inter) so it degrades gracefully.
 *   4. missing-font-file   — an @font-face src points at a file not in the build.
 *   5. no-font-face        — the first family in the resolved body stack is a
 *                            custom name with no @font-face rule anywhere.
 *
 * USAGE
 *   node scripts/check-font-integrity.js [buildDir]
 *   node scripts/check-font-integrity.js --json
 *
 * Exits 1 on any failure. Intended to run right after `vercel build` /
 * `next build`, before the deploy step.
 */

const fs = require('fs');
const path = require('path');

const CANDIDATE_DIRS = ['.vercel/output/static', 'out', '.next'];

// Families that need no @font-face: CSS generics + fonts that ship with an OS.
const SYSTEM_FAMILIES = new Set(
  [
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
    'fangsong', 'inherit', 'initial', 'unset', 'revert',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto',
    'helvetica neue', 'helvetica', 'arial', 'noto sans', 'liberation sans',
    'apple color emoji', 'segoe ui emoji', 'segoe ui symbol', 'noto color emoji',
    'sfmono-regular', 'menlo', 'monaco', 'consolas', 'liberation mono',
    'courier new', 'times new roman', 'georgia', 'cambria', 'tahoma', 'verdana',
  ].map((s) => s.toLowerCase())
);

function walk(dir, exts, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // node_modules/cache dirs hold build intermediates, not shipped assets.
      if (e.name === 'node_modules' || e.name === 'cache') continue;
      walk(full, exts, out, depth + 1);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

function resolveBuildDir(explicit) {
  if (explicit) return explicit;
  for (const d of CANDIDATE_DIRS) {
    if (fs.existsSync(d) && walk(d, ['.html']).length > 0) return d;
  }
  return null;
}

/** Strip quotes and normalize a font family token for comparison. */
function normFamily(raw) {
  return raw.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

/**
 * Split a font-family value on top-level commas only, so that
 * `var(--a, "X, Y"), Arial` doesn't get shredded inside the var().
 */
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

function analyze(buildDir) {
  const cssFiles = walk(buildDir, ['.css']);
  const htmlFiles = walk(buildDir, ['.html']);
  const failures = [];
  const notes = [];

  if (cssFiles.length === 0) failures.push({ check: 'no-css', detail: `No .css files under ${buildDir}` });
  if (htmlFiles.length === 0) failures.push({ check: 'no-html', detail: `No .html files under ${buildDir}` });
  if (failures.length) return { failures, notes, cssFiles, htmlFiles };

  // Strip comments first. Production CSS is minified so they're already gone,
  // but dev/unminified output keeps them — and prose *about* font-family (like
  // the incident write-up at the top of globals.css) would otherwise be parsed
  // as real declarations and reported as failures.
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssByFile = new Map(cssFiles.map((f) => [f, stripComments(fs.readFileSync(f, 'utf8'))]));
  const allCss = [...cssByFile.values()].join('\n');

  // ---- Index every custom property definition and the selector it sits under.
  // definedProps: '--font-inter' -> Set of selector strings that define it
  const definedProps = new Map();
  const propDefRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = propDefRe.exec(allCss)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    const declRe = /(--[A-Za-z0-9_-]+)\s*:/g;
    let d;
    while ((d = declRe.exec(body)) !== null) {
      if (!definedProps.has(d[1])) definedProps.set(d[1], new Set());
      definedProps.get(d[1]).add(selector);
    }
  }

  // ---- Index @font-face families and their src files.
  const fontFaceFamilies = new Set();
  const fontFaceSrcs = [];
  const faceRe = /@font-face\s*\{([^}]*)\}/g;
  while ((m = faceRe.exec(allCss)) !== null) {
    const body = m[1];
    const fam = body.match(/font-family\s*:\s*([^;]+);?/);
    if (fam) fontFaceFamilies.add(normFamily(fam[1]));
    const srcRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    let s;
    while ((s = srcRe.exec(body)) !== null) fontFaceSrcs.push(s[1]);
  }
  notes.push(`@font-face families: ${[...fontFaceFamilies].join(', ') || '(none)'}`);

  // ---- Class names actually present in shipped HTML.
  const htmlClasses = new Set();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, 'utf8');
    const clsRe = /class="([^"]*)"/g;
    let c;
    while ((c = clsRe.exec(html)) !== null) {
      for (const cls of c[1].split(/\s+/)) if (cls) htmlClasses.add(cls);
    }
  }

  // ---- Walk every font-family declaration in the shipped CSS.
  const ffRe = /font-family\s*:\s*([^;}]+)/g;
  const seenVarIssues = new Set();
  const seenFamilyIssues = new Set();
  let firstResolvedStack = null;

  while ((m = ffRe.exec(allCss)) !== null) {
    const value = m[1].trim();
    const parts = splitTopLevel(value);
    if (!firstResolvedStack && /intervariable|font-inter/i.test(value)) firstResolvedStack = value;

    for (const part of parts) {
      const varMatch = part.match(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/);
      if (varMatch) {
        const prop = varMatch[1];
        const hasFallback = Boolean(varMatch[2]);
        const defs = definedProps.get(prop);

        if (!defs) {
          const key = `undefined:${prop}`;
          if (!seenVarIssues.has(key)) {
            seenVarIssues.add(key);
            failures.push({
              check: 'undefined-var',
              detail:
                `font-family uses var(${prop}) but no CSS rule defines ${prop}. ` +
                `The whole declaration is invalid at computed-value time, so the ` +
                `browser falls back to its default font (serif), not to the rest ` +
                `of this stack. Declaration: "${value.slice(0, 120)}"`,
            });
          }
          continue;
        }

        // Defined — but is any defining selector actually reachable?
        const classSelectors = [...defs].filter((s) => /^\.[A-Za-z0-9_-]+$/.test(s));
        const nonClassSelectors = [...defs].filter((s) => !/^\.[A-Za-z0-9_-]+$/.test(s));
        if (nonClassSelectors.length === 0 && classSelectors.length > 0) {
          const reachable = classSelectors.some((s) => htmlClasses.has(s.slice(1)));
          if (!reachable) {
            const key = `unreachable:${prop}`;
            if (!seenVarIssues.has(key)) {
              seenVarIssues.add(key);
              failures.push({
                check: 'unreachable-var',
                detail:
                  `${prop} is only defined under selector(s) ${classSelectors.join(', ')}, ` +
                  `and none of those classes appear in any shipped HTML. This is the ` +
                  `2026-08-16 next/font hash-mismatch signature — CSS and HTML came ` +
                  `from different builds. The site will render in the browser default font.`,
              });
            }
          }
        }

        if (!hasFallback) {
          const key = `nofallback:${prop}`;
          if (!seenVarIssues.has(key)) {
            seenVarIssues.add(key);
            failures.push({
              check: 'var-without-fallback',
              detail:
                `font-family uses bare var(${prop}) with no fallback. Write ` +
                `var(${prop}, Inter) so an undefined property degrades to the rest ` +
                `of the stack instead of poisoning the whole declaration.`,
            });
          }
        }
        continue;
      }

      // Literal family name.
      const fam = normFamily(part);
      if (!fam || SYSTEM_FAMILIES.has(fam)) continue;
      if (fontFaceFamilies.has(fam)) continue;
      // Only flag the FIRST (primary) family of a stack — later entries are
      // intentionally-optional "use it if the user happens to have it" hints.
      if (normFamily(parts[0]) !== fam) continue;
      const key = `noface:${fam}`;
      if (!seenFamilyIssues.has(key)) {
        seenFamilyIssues.add(key);
        failures.push({
          check: 'no-font-face',
          detail:
            `Primary font family "${part.trim()}" has no @font-face rule and is not a ` +
            `system font, so it only renders for users who happen to have it installed.`,
        });
      }
    }
  }

  // ---- Every @font-face src must exist in the build output.
  for (const src of [...new Set(fontFaceSrcs)]) {
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue;
    const rel = src.split('?')[0].replace(/^\//, '');
    if (!fs.existsSync(path.join(buildDir, rel))) {
      failures.push({
        check: 'missing-font-file',
        detail: `@font-face src "${src}" is not present in ${buildDir}. Users get a 404 and no font.`,
      });
    }
  }

  if (firstResolvedStack) notes.push(`body font stack: ${firstResolvedStack.slice(0, 160)}`);
  notes.push(`scanned ${cssFiles.length} CSS file(s), ${htmlFiles.length} HTML file(s)`);
  return { failures, notes, cssFiles, htmlFiles };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const explicit = args.find((a) => !a.startsWith('--'));
  const buildDir = resolveBuildDir(explicit);

  if (!buildDir) {
    console.error(
      `[font-integrity] No build output found (looked in: ${CANDIDATE_DIRS.join(', ')}).\n` +
        `Run a build first, or pass the directory explicitly.`
    );
    process.exit(1);
  }

  const { failures, notes } = analyze(buildDir);

  if (asJson) {
    console.log(JSON.stringify({ buildDir, ok: failures.length === 0, failures, notes }, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  }

  console.log(`[font-integrity] build dir: ${buildDir}`);
  for (const n of notes) console.log(`[font-integrity]   ${n}`);

  if (failures.length === 0) {
    console.log('[font-integrity] ✓ fonts resolve correctly in the shipped output');
    process.exit(0);
  }

  console.error(`\n[font-integrity] ✗ ${failures.length} problem(s) — the live site would lose its font:\n`);
  for (const f of failures) console.error(`  [${f.check}] ${f.detail}\n`);
  console.error(
    '[font-integrity] This gate exists because the 2026-08-16 serif incident passed\n' +
      '[font-integrity] tsc, lint, the build, and every deploy health check. Do not skip it.'
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { analyze, splitTopLevel, normFamily };
