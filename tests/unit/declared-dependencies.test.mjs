// BRO-6408: every bare package the code imports must be declared in package.json.
// BRO-6398: js-yaml was required by 37 files but only present through transitive
// hoisting, so an npm override that changed the tree broke every one of them with
// MODULE_NOT_FOUND. Declared-vs-hoisted is invisible to `npm ci` and to
// scripts/audit-missing-deps.js (which only checks workflow-invoked eager requires).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);

// Imported but deliberately not declared. Each needs a reason; the test fails
// if an entry stops being imported anywhere so the list cannot rot.
const ALLOWLIST = {
  dotenv: 'only loaded inside try/catch (score-video-reviews.js) or by .ts test scripts run by hand; scripts/lib/load-env.js is the supported loader',
  googleapis: 'workflows `npm install` it at run time before the scripts that need it run',
  puppeteer: 'legacy scripts/scrape-show-score.js; fetchPage() is the supported path and the script is run by hand only',
};

// Specifiers that resolve without an npm package of that name.
const IGNORED_PREFIXES = ['@/', '~/'];
const SCAN_DIRS = ['scripts', 'src', 'tests'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', '.git', 'fixtures']);
// Nothing quoted may precede the call on its line, so require()/import text inside
// string fixtures is not scanned (comments are skipped by the same rule below).
const STMT = '^[^\'"\\x60\\n]*?(?<![\\w.$])';
const SPEC_RES = [
  new RegExp(STMT + String.raw`require\(\s*['"]([^'"\n]+)['"]\s*\)`, 'gm'),
  new RegExp(STMT + String.raw`import\(\s*['"]([^'"\n]+)['"]\s*\)`, 'gm'),
  /^[ \t]*import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"\n]+)['"]/gm,
  /^[ \t]*export\s+[^'";]*?\sfrom\s+['"]([^'"\n]+)['"]/gm,
];
// Files whose job is to embed import/require text as test input.
const FIXTURE_FILES = new Set([
  'scripts/audit-missing-deps.test.mjs',
  'scripts/lib/unbounded-fetch-guard.test.mjs',
  'scripts/audit-run-budget-coverage.test.mjs',
  'tests/unit/perf-lazy-loading.test.ts',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(c|m)?(js|ts)x?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  if (IGNORED_PREFIXES.some((p) => spec.startsWith(p))) return null;
  if (spec === 'server-only') return null; // Next.js build-time marker, resolved by next itself
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ? name : null;
}

function scan() {
  const used = new Map(); // package -> first file
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      if (FIXTURE_FILES.has(relative(ROOT, file))) continue;
      const src = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      for (const re of SPEC_RES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
          const name = packageName(m[1]);
          if (name && !used.has(name)) used.set(name, relative(ROOT, file));
        }
      }
    }
  }
  return used;
}

const used = scan();

test('packageName normalises specifiers', () => {
  assert.equal(packageName('fs'), null);
  assert.equal(packageName('node:fs'), null);
  assert.equal(packageName('fs/promises'), null);
  assert.equal(packageName('./x'), null);
  assert.equal(packageName('@/lib/x'), null);
  assert.equal(packageName('lodash/get'), 'lodash');
  assert.equal(packageName('@next/env'), '@next/env');
  assert.equal(packageName('@next/env/dist/x'), '@next/env');
});

test('every imported package is declared in package.json', () => {
  const missing = [...used]
    .filter(([name]) => !declared.has(name) && !(name in ALLOWLIST))
    .map(([name, file]) => `${name} (first seen in ${file})`);
  assert.deepEqual(missing, [], `undeclared imports (hoisted transitively, will break when the tree changes):\n  ${missing.join('\n  ')}\nAdd to package.json or to ALLOWLIST with a reason.`);
});

test('ALLOWLIST entries are still imported and still undeclared', () => {
  for (const name of Object.keys(ALLOWLIST)) {
    assert.ok(used.has(name), `${name} is no longer imported anywhere; drop it from ALLOWLIST`);
    assert.ok(!declared.has(name), `${name} is now declared; drop it from ALLOWLIST`);
  }
});
