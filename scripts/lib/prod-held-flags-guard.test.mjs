// Tests for prod-held-flags-guard.js: the pre-build check that keeps
// owner-held features (BRO-4525: commercial) out of production deploys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHeldFeatures, featuresFromEnvFile, heldFeaturesEnabled, main } = require('./prod-held-flags-guard.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('feature-flags.ts holds commercial back from production', () => {
  assert.ok(parseHeldFeatures(read('src/config/feature-flags.ts')).includes('commercial'));
});

test('an empty held list parses (releasing the last held feature must not break deploys)', () => {
  assert.deepEqual(parseHeldFeatures('export const PROD_HELD_FEATURES = new Set([]);'), []);
  assert.deepEqual(parseHeldFeatures('export const PROD_HELD_FEATURES = new Set([\n]);'), []);
});

test('a missing or renamed declaration throws instead of passing', () => {
  assert.throws(() => parseHeldFeatures('const DEMO_FEATURES = new Set([\'showtimes\']);'), /not found/);
});

test('typed and double-quoted declarations parse', () => {
  const src = 'export const PROD_HELD_FEATURES: ReadonlySet<string> = new Set<string>(["a", \'b\']);';
  assert.deepEqual(parseHeldFeatures(src), ['a', 'b']);
});

test('held names the tokenizer could never match are rejected', () => {
  assert.throws(() => parseHeldFeatures("export const PROD_HELD_FEATURES = new Set(['biz-v2']);"), /cannot match/);
});

// 'held' (guard reports commercial), 'refused' (guard can't read the file with
// certainty and fails), or 'clean'.
function verdict(envText) {
  try {
    return heldFeaturesEnabled(featuresFromEnvFile(envText), ['commercial']).length ? 'held' : 'clean';
  } catch {
    return 'refused';
  }
}

// [env file text, guard verdict]. The cross-check below runs every fixture
// through both real loaders and fails if either enables commercial on a 'clean'.
const ENV_FIXTURES = [
  ['VERCEL="1"\nNEXT_PUBLIC_FEATURES="westEnd,commercial"\n', 'held'],
  ["NEXT_PUBLIC_FEATURES='commercial'", 'held'],
  ['NEXT_PUBLIC_FEATURES=westEnd', 'clean'],
  ['OTHER=1\n', 'clean'],
  ['export NEXT_PUBLIC_FEATURES="commercial"', 'held'],
  ['NEXT_PUBLIC_FEATURES: commercial', 'held'],
  ['NEXT_PUBLIC_FEATURES=westEnd,commercial # held', 'held'],
  ['NEXT_PUBLIC_FEATURES="westEnd" # note', 'clean'],
  ['NEXT_PUBLIC_FEATURES="westEnd"\r\nNEXT_PUBLIC_FEATURES="commercial"\r\n', 'held'],
  // Both loaders let the last line win; the guard counts every line.
  ['NEXT_PUBLIC_FEATURES="commercial"\nNEXT_PUBLIC_FEATURES="westEnd"\n', 'held'],
  ['NEXT_PUBLIC_FEATURES="a\\"b,commercial"', 'held'],
  ['NEXT_PUBLIC_FEATURES="x" ,commercial', 'held'],
  // vercel pull writes a newline inside a value as a literal \n (or \r).
  ['NEXT_PUBLIC_FEATURES="westEnd,\\ncommercial"\n', 'held'],
  ['NEXT_PUBLIC_FEATURES="westEnd,\\rcommercial"\n', 'held'],
  ['NEXT_PUBLIC_FEATURES="westEnd"\nZ_NOTE="commercial"\n', 'clean'],
  // Multi-line values (Next's dotenv reads these; vercel pull never writes them).
  ['NEXT_PUBLIC_FEATURES="westEnd,\ncommercial"\nVERCEL="1"\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES="westEnd,\nX=1,commercial"\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES="westEnd,\\"\nX=1,commercial"\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES=\n"commercial"\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES=commercial\nNOTE="\nNEXT_PUBLIC_FEATURES=westEnd\n"\n', 'refused'],
  // U+2028/U+2029 end a line for Next's dotenv, and vercel pull leaves them raw
  // in values. A secret holding one must not block deploys.
  ['API_KEY="x\u2028y"\nNEXT_PUBLIC_FEATURES="westEnd"\n', 'clean'],
  ["A='x'\u2028NEXT_PUBLIC_FEATURES=commercial\n", 'refused'],
  ['NEXT_PUBLIC_FEATURES=\u2028"commercial"\n', 'held'],
  ['NEXT_PUBLIC_FEATURES="westEnd\u2029commercial"\n', 'held'],
  ['A=1\u2028NEXT_PUBLIC_FEATURES=\n"commercial"\n', 'refused'],
  ['# note\u2028NEXT_PUBLIC_FEATURES=commercial\n', 'refused'],
  // Next's dotenv also reads U+2028 as a space between a key and its = or :.
  ['NEXT_PUBLIC_FEATURES="westEnd"\n# x\u2028NEXT_PUBLIC_FEATURES\u2028=commercial\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES="westEnd"\nZ="x"\u2028NEXT_PUBLIC_FEATURES\u2028=commercial\n', 'refused'],
  ['Z="x"\u2028NEXT_PUBLIC_FEATURES:\u2028commercial\n', 'refused'],
  ['NEXT_PUBLIC_FEATURES\u2028=commercial\n', 'refused'],
  // An empty value lets Next's dotenv take a quoted value from a later line.
  ['NEXT_PUBLIC_FEATURES=\n\u2028"commercial"\n', 'refused'],
  ["# Created by Vercel CLI\nA=\"1\"\nNEXT_PUBLIC_FEATURES= \n \u2029'commercial'\nZ=\"2\"\n", 'refused'],
  ['NEXT_PUBLIC_FEATURES=""\n', 'clean'],
  // A lone \r is a line break to Next's dotenv; vercel pull escapes it.
  ['A="x"\u2028NEXT_PUBLIC_FEATURES=commercial\rB=2\n', 'refused'],
  ['# note\rNEXT_PUBLIC_FEATURES=commercial\n', 'refused'],
  // Real vercel pull output: header, sorted KEY="value" lines, raw $ and a
  // trailing backslash in other keys. Must not be refused.
  ['# Created by Vercel CLI\nA_URL="https://x.test/?a=$b"\nNEXT_PUBLIC_FEATURES="westEnd,userAccounts"\nWIN_PATH="C:\\dir\\"\n', 'clean'],
];

test('the guard reads the pulled env file however NEXT_PUBLIC_FEATURES is formatted', () => {
  assert.equal(featuresFromEnvFile('OTHER=1\n'), '');
  for (const [text, expected] of ENV_FIXTURES) assert.equal(verdict(text), expected, JSON.stringify(text));
});

// `vercel build` loads the pulled file with the Vercel CLI's bundled dotenv;
// `next build` reads the repo's env files with @next/env. Both run in a child
// process because they write process.env. If the CLI's loader can't be found,
// the CLI changed how vercel build reads .vercel/.env.production.local:
// re-check prod-held-flags-guard.js against the new loader before fixing this.
test('the guard never passes a file either real env loader would enable commercial from', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'held-flags-loaders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dirs = ENV_FIXTURES.map(([text], i) => {
    const d = path.join(dir, String(i));
    mkdirSync(d);
    writeFileSync(path.join(d, '.env.production.local'), text);
    return d;
  });
  const script = `
    const fs = require('fs'), path = require('path');
    const has = v => String(v || '').split(',').map(s => s.trim()).includes('commercial');
    (async () => {
      // Resolve like require() does (walks up), so worktrees without their own node_modules work.
      const buildDir = path.join(path.dirname(require.resolve('vercel/package.json', { paths: [process.cwd()] })), 'dist/commands/build');
      const src = fs.readFileSync(path.join(buildDir, 'index.js'), 'utf8');
      const name = (src.match(/var import_dotenv = __toESM\\((\\w+)\\(\\)/) || [])[1];
      if (!/\`\\.env\\.\\$\\{target\\}\\.local\`[\\s\\S]{0,200}?import_dotenv\\.default\\.config\\(/.test(src)) throw new Error('vercel build no longer loads .vercel/.env.<target>.local with import_dotenv');
      // The chunk that exports it, matched on the local binding (\`a\` or \`a as name\`).
      let exported, chunk;
      for (const m of name ? src.matchAll(/import \\{([^}]*)\\} from "([^"]+)"/g) : []) {
        const spec = m[1].split(',').map(x => x.trim().split(/\\s+as\\s+/)).find(x => x[x.length - 1] === name);
        if (spec) { exported = spec[0]; chunk = m[2]; break; }
      }
      if (!chunk) throw new Error('Vercel CLI env loader not found in commands/build/index.js');
      const vercelDotenv = (await import(path.join(buildDir, chunk)))[exported]();
      const { loadEnvConfig } = require('@next/env');
      const out = JSON.parse(process.argv[1]).map(d => {
        const text = fs.readFileSync(path.join(d, '.env.production.local'), 'utf8');
        return {
          vercel: has(vercelDotenv.parse(text).NEXT_PUBLIC_FEATURES),
          next: has(loadEnvConfig(d, false, { info() {}, error() {} }, true).combinedEnv.NEXT_PUBLIC_FEATURES),
        };
      });
      console.log(JSON.stringify(out));
    })().catch(e => { console.error(e.message); process.exit(1); });`;
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_FEATURES;
  delete env.NODE_ENV; // NODE_ENV=test makes @next/env skip .env.production.local
  const seen = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(dirs)], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 }));
  ENV_FIXTURES.forEach(([text], i) => {
    const { vercel, next } = seen[i];
    if (vercel || next) assert.notEqual(verdict(text), 'clean', `guard passed a file that enables commercial (vercel=${vercel}, next=${next}): ${JSON.stringify(text)}`);
  });
  // The fixtures must actually exercise both loaders.
  assert.ok(seen.some(s => s.vercel) && seen.some(s => s.next && !s.vercel), 'fixtures no longer cover both loaders');
});

test('held features are matched as whole names only', () => {
  assert.deepEqual(heldFeaturesEnabled('westEnd, commercial ', ['commercial']), ['commercial']);
  assert.deepEqual(heldFeaturesEnabled('commercialX,biz', ['commercial']), []);
  assert.deepEqual(heldFeaturesEnabled('commercial_x', ['commercial']), []);
  assert.deepEqual(heldFeaturesEnabled(undefined, ['commercial']), []);
});

test('main(): fails on a held flag in the env file or the shell, passes otherwise, fails without the file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'held-flags-'));
  const file = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
  const withHeld = file('held.env', 'NEXT_PUBLIC_FEATURES="westEnd,commercial"\n');
  const clean = file('clean.env', 'NEXT_PUBLIC_FEATURES="westEnd,tonyPredictions"\n');
  const unset = file('unset.env', '# Created by Vercel CLI\nVERCEL="1"\n');
  const multiline = file('multi.env', 'API_KEY="sk-secret-one\nsk-secret-two"\nNEXT_PUBLIC_FEATURES="westEnd"\n');
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'held-flags-root-'));
  const localRoot = mkdtempSync(path.join(os.tmpdir(), 'held-flags-root-'));
  writeFileSync(path.join(localRoot, '.env.local'), 'NEXT_PUBLIC_FEATURES=westEnd,commercial\n');
  const errors = [];
  const quiet = { error: console.error, log: console.log };
  console.error = (...a) => errors.push(a.join(' '));
  console.log = () => {};
  try {
    assert.equal(main([withHeld], {}, emptyRoot), 1);
    assert.equal(main([clean], {}, emptyRoot), 0);
    assert.equal(main([clean], { NEXT_PUBLIC_FEATURES: 'commercial' }, emptyRoot), 1);
    assert.equal(main([path.join(dir, 'missing.env')], {}, emptyRoot), 1);
    assert.equal(main([clean], { NEXT_PUBLIC_FEATURES: '${HELD}' }, emptyRoot), 1);
    // Refused file: fails, and the error names a line, never a value.
    errors.length = 0;
    assert.equal(main([multiline], {}, emptyRoot), 1);
    assert.ok(errors.some(e => /line 2/.test(e)) && !errors.some(e => /sk-secret/.test(e)), errors.join('\n'));
    // Production doesn't set the key: next build would fall back to the repo's .env files.
    assert.equal(main([unset], {}, emptyRoot), 0);
    assert.equal(main([unset], {}, localRoot), 1);
    assert.equal(main([unset], { NEXT_PUBLIC_FEATURES: 'westEnd' }, localRoot), 0);
    assert.equal(main([clean], {}, localRoot), 0);
    // A line the Vercel loader rejects doesn't set the key, so the fallback still applies.
    assert.equal(main([file('rejected.env', 'NEXT_PUBLIC_FEATURES="westEnd\u2028x"\n')], {}, localRoot), 1);
    assert.equal(main([file('in-secret.env', 'A="x\u2028NEXT_PUBLIC_FEATURES=westEnd"\n')], {}, localRoot), 1);
  } finally {
    Object.assign(console, quiet);
    for (const d of [dir, emptyRoot, localRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// Line number of the first non-comment line containing `needle` (-1 if none),
// so a comment that mentions a command can't satisfy or break the ordering check.
function codeLine(text, needle) {
  return text.split('\n').findIndex(l => !/^\s*(#|\/\/|\*|\/\*)/.test(l) && l.includes(needle));
}

test('both prod deploy paths run the guard before vercel build --prod', () => {
  const wf = read('.github/workflows/vercel-deploy.yml');
  const wfGuard = codeLine(wf, 'node scripts/lib/prod-held-flags-guard.js');
  assert.ok(wfGuard > 0, 'vercel-deploy.yml must run prod-held-flags-guard.js');
  assert.ok(wfGuard > codeLine(wf, 'npx vercel pull --yes --environment=production'), 'guard runs after vercel pull');
  assert.ok(wfGuard < codeLine(wf, 'npx vercel build --prod'), 'guard runs before vercel build --prod');

  const dn = read('scripts/deploy-now.js');
  const dnGuard = codeLine(dn, 'checkHeldFeatures([], env)');
  assert.ok(dnGuard > 0, 'deploy-now.js must call the guard');
  assert.ok(dnGuard > codeLine(dn, 'vercel pull --yes --environment=production'), 'deploy-now: guard after vercel pull');
  assert.ok(dnGuard < codeLine(dn, 'vercel build --prod'), 'deploy-now: guard before vercel build --prod');
});

// A shell grep of the pulled file misses duplicate lines, `export` and escaped \n
// (the demo-flag step did, until BRO-4525), so NEXT_PUBLIC_FEATURES is read only
// with this parser. The guard also sees only its own step: a later step that
// rewrites an env file the build loads (.env, .env.*, the pulled .vercel files,
// another vercel pull) or sets NEXT_PUBLIC_FEATURES (step env:, $GITHUB_ENV)
// would get past it. Every such line must be a known one.
const touchesBuildEnv = l => /(^|[^\w.-])\.(env|vercel)\b|\bvercel\s+(env\s+)?pull\b|NEXT_PUBLIC_FEATURES|GITHUB_ENV/.test(l);
const unknownEnvLines = (text, known = []) => text.split('\n').map(l => l.trim())
  .filter(l => !l.startsWith('#') && touchesBuildEnv(l) && !known.includes(l));

test('the workflow scan flags each way a later step could change what the build sees', () => {
  const flagged = [
    'echo X >> .env', 'cp a .env', 'cd .vercel', 'cat ./.vercel/x', 'source "$GITHUB_WORKSPACE/.vercel/x"',
    'cat ${{ github.workspace }}/.vercel/x', 'npx vercel env pull', 'npx vercel pull --environment=preview',
    'echo "NEXT_PUBLIC_FEATURES=commercial" >> "$GITHUB_ENV"', 'NEXT_PUBLIC_FEATURES: commercial',
  ];
  for (const l of flagged) assert.deepEqual(unknownEnvLines(l), [l], l);
  for (const l of ['curl https://api.vercel.com/v6/deployments', 'node -e "console.log(process.env.X)"', 'echo "x=1" >> "$GITHUB_OUTPUT"']) {
    assert.deepEqual(unknownEnvLines(l), [], l);
  }
});

test('vercel-deploy.yml touches the build env only in known ways', () => {
  const wf = read('.github/workflows/vercel-deploy.yml');
  // Whole lines, so nothing can be chained onto an allowed one.
  const known = [
    'run: npx vercel pull --yes --environment=production --token=$VERCEL_TOKEN',
    "value = g.featuresFromEnvFile(require('fs').readFileSync('.vercel/.env.production.local', 'utf8'));", // demo-flag step
    "console.error('::error::.env.production.local: ' + e.message);",
    'echo "::error::Demo-only feature flags found in production NEXT_PUBLIC_FEATURES: $LEAKED"',
    'echo "DEMO_FLAGS=$DEMO_FLAGS" >> "$GITHUB_ENV"',
    'run: node scripts/lib/prod-held-flags-guard.js .vercel/.env.production.local',
    'grep -Eq "^${v}=\\"?[^\\"[:space:]]" .vercel/.env.production.local 2>/dev/null || MISSING="$MISSING $v"', // Supabase step
    'run: rm -rf .vercel/output',
  ];
  assert.deepEqual(unknownEnvLines(wf, known), [], 'read NEXT_PUBLIC_FEATURES with featuresFromEnvFile; add other lines here once checked');
  assert.match(wf, /for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do/);
  // Composite actions run inside the job too; none may touch the build env.
  const actions = [...wf.matchAll(/uses:\s*\.\/(\.github\/actions\/[\w-]+)/g)].map(m => m[1]);
  assert.ok(actions.length > 0, 'expected vercel-deploy.yml to use local composite actions');
  for (const dir of new Set(actions)) {
    const file = ['action.yml', 'action.yaml'].map(f => `${dir}/${f}`).find(f => existsSync(path.join(ROOT, f)));
    assert.ok(file, `${dir} has no action.yml`);
    assert.deepEqual(unknownEnvLines(read(file)), [], `${file} touches the build env`);
  }
});
