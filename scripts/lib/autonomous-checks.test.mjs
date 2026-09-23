import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const checks = require('./autonomous-checks.js');
const {
  decideChecks, cardCheckArgv, checksEnv, isUiDiff, hasSrcChange,
  prepareCheckWorkdir, resolveInstallRoot, runSafeChecks, BUILD_TIMEOUT_MS, BUILD_ENV,
} = checks;

const never = () => false;
const always = () => true;
const names = list => list.map(c => c.name);

// ── decideChecks: tier 1 (unchanged behavior) ───────────────────────────────

test('tier 1: colocated tests + tsc only, never lint or build', () => {
  const exists = f => f === 'scripts/lib/foo.test.mjs';
  const out = decideChecks(['scripts/lib/foo.js', 'tests/unit/bar.test.mjs', 'src/lib/x.ts'], exists);
  assert.deepEqual(names(out), ['colocated-tests', 'tsc']);
  assert.deepEqual(out[0].argv, ['node', '--test', 'scripts/lib/foo.test.mjs', 'tests/unit/bar.test.mjs']);
  assert.deepEqual(out[1].argv, ['npx', 'tsc', '--noEmit']);
});

test('tier 1: docs/memory-only diff has nothing to run', () => {
  assert.deepEqual(decideChecks(['docs/readme.md', 'memory/x.md'], never), []);
});

// ── decideChecks: tier 3 (S2-T4) ────────────────────────────────────────────

test('tier 3: a src/ diff yields tsc + lint + build', () => {
  const out = decideChecks(['src/components/Foo.tsx'], never, { tier: 3 });
  assert.deepEqual(names(out), ['tsc', 'next lint', 'next build']);
  const build = out.find(c => c.name === 'next build');
  assert.equal(build.build, true);
  assert.equal(build.timeoutMs, BUILD_TIMEOUT_MS, 'build gets its own longer timeout');
});

test('tier 3: a non-ts src/ diff (css) still lints and builds', () => {
  assert.deepEqual(names(decideChecks(['src/app/globals.css'], never, { tier: 3 })), ['next lint', 'next build']);
});

test('tier 3: buildCheck:false drops only the build', () => {
  assert.deepEqual(
    names(decideChecks(['src/components/Foo.tsx'], never, { tier: 3, buildCheck: false })),
    ['tsc', 'next lint']);
});

test('tier 3: a scripts/ diff yields colocated tests + node --check, no lint/build', () => {
  const exists = f => f === 'scripts/lib/foo.test.mjs';
  const out = decideChecks(['scripts/lib/foo.js', 'scripts/bare.js'], exists, { tier: 3 });
  assert.deepEqual(names(out), ['colocated-tests', 'node --check scripts/bare.js', 'node --check scripts/lib/foo.js']);
  assert.deepEqual(out[1].argv, ['node', '--check', 'scripts/bare.js']);
});

test('tier 3: a test file is not double-run through node --check', () => {
  const out = decideChecks(['scripts/lib/foo.test.mjs'], never, { tier: 3 });
  assert.deepEqual(names(out), ['colocated-tests']);
});

// BRO-2247: same TS-resolution trap BRO-2218 fixed in isSafeCheckCommand, here
// at the auto-derivation call site — a colocated .test.ts must be found (not
// just .test.mjs) and routed through tsx (not plain node, which can't parse
// TS syntax or resolve a TS module's extensionless internal imports).
test('tier 3: a colocated .test.ts is derived and routed through tsx, not plain node', () => {
  const exists = f => f === 'scripts/lib/foo.test.ts';
  const out = decideChecks(['scripts/lib/foo.ts'], exists, { tier: 3 });
  const tsxCheck = out.find(c => c.name === 'colocated-tests-tsx');
  assert.ok(tsxCheck, 'a colocated .test.ts must be auto-derived');
  assert.deepEqual(tsxCheck.argv, ['npx', 'tsx', '--test', 'scripts/lib/foo.test.ts']);
  assert.equal(out.some(c => c.name === 'colocated-tests'), false,
    'a .test.ts colocated file must never be handed to plain node --test');
});

test('tier 3: a diff mixing .test.mjs and .test.ts colocated tests runs two separate batches', () => {
  const exists = f => f === 'scripts/lib/foo.test.mjs' || f === 'scripts/lib/bar.test.ts';
  const out = decideChecks(['scripts/lib/foo.js', 'scripts/lib/bar.ts'], exists, { tier: 3 });
  const byName = Object.fromEntries(out.map(c => [c.name, c]));
  assert.deepEqual(byName['colocated-tests'].argv, ['node', '--test', 'scripts/lib/foo.test.mjs']);
  assert.deepEqual(byName['colocated-tests-tsx'].argv, ['npx', 'tsx', '--test', 'scripts/lib/bar.test.ts']);
});

// Real-filesystem, real-execution proof (not just an argv assertion): a
// fixture .ts source with a colocated .test.ts is found on disk by the real
// decideChecks() and the derived check actually PASSES under tsx. The test
// imports its sibling module via an EXTENSIONLESS path (`./foo`, not
// `./foo.js`) — the exact case BRO-2218/BRO-2247 exist to fix. That is not
// merely non-idiomatic; recent Node versions (22.6+) natively strip TS type
// annotations, so a fixture that only relied on a type annotation being
// "invalid JS" would silently pass under PLAIN `node --test` too and prove
// nothing (caught in review — the first cut of this fixture had exactly that
// gap on this machine's Node version). An extensionless internal import
// fails ERR_MODULE_NOT_FOUND under plain node on every Node version — only
// tsx's TS-aware resolver follows it — so a pass here can only mean tsx ran.
test('a real colocated .test.ts fixture is auto-derived and actually passes under tsx (BRO-2247)', () => {
  const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const repoRoot = path.dirname(path.resolve(gitCommonDir));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-tsx-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'foo.ts'), 'export const x: number = 1;\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'foo.test.ts'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { x } from './foo';",
    "test('trivial', () => { assert.equal(x, 1); });",
    '',
  ].join('\n'));

  const results = runSafeChecks({
    cwd: dir, changedFiles: ['scripts/foo.ts'], isSafeCheckCommand: () => false, tier: 3, prepareFrom: repoRoot,
  });
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.ok(byName['colocated-tests-tsx'], 'the real filesystem colocated .test.ts must be auto-derived');
  assert.equal(byName['colocated-tests-tsx'].pass, true, byName['colocated-tests-tsx'].detail);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tier 1 never gains the tier-3 checks for the same diff', () => {
  const files = ['src/components/Foo.tsx', 'scripts/bare.js'];
  const t1 = names(decideChecks(files, never, { tier: 1 }));
  const t3 = names(decideChecks(files, never, { tier: 3 }));
  assert.deepEqual(t1, ['tsc']);
  assert.ok(t3.includes('next build') && t3.includes('node --check scripts/bare.js'));
});

test('decideChecks is deterministic for the same input (parity precondition)', () => {
  const files = ['src/components/Foo.tsx', 'scripts/lib/foo.js', 'tests/unit/x.test.mjs'];
  const a = decideChecks(files, always, { tier: 3 });
  const b = decideChecks([...files].reverse(), always, { tier: 3 });
  assert.deepEqual(names(a).sort(), names(b).sort());
});

// ── card check ──────────────────────────────────────────────────────────────

test('cardCheckArgv refuses anything the validator rejects', () => {
  const safe = c => c === 'npx tsc --noEmit';
  assert.deepEqual(cardCheckArgv('npx tsc --noEmit', safe), ['npx', 'tsc', '--noEmit']);
  assert.equal(cardCheckArgv('rm -rf /', safe), null);
  assert.equal(cardCheckArgv('', safe), null);
  assert.equal(cardCheckArgv(null, safe), null);
});

// ── env ─────────────────────────────────────────────────────────────────────

test('checksEnv strips secrets, fakes HOME, and disables git prompting', () => {
  const env = checksEnv({ env: { PATH: '/bin', HOME: '/Users/real', NOTION_API_KEY: 'secret', ANTHROPIC_API_KEY: 'k', RESEND_API_KEY: 'r' } });
  assert.equal(env.NOTION_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.RESEND_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.notEqual(env.HOME, '/Users/real');
  assert.ok(fs.existsSync(env.HOME), 'fake HOME is a real empty dir');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('checksEnv build mode adds the NEXT_PUBLIC allow-list and nothing else', () => {
  const env = checksEnv({ env: { PATH: '/bin', NOTION_API_KEY: 'secret', NEXT_PUBLIC_SNEAKY: 'x' }, build: true });
  assert.equal(env.NEXT_PUBLIC_FEATURES, BUILD_ENV.NEXT_PUBLIC_FEATURES);
  assert.equal(env.NEXT_PUBLIC_SNEAKY, undefined, 'ambient NEXT_PUBLIC_* is not inherited — only the explicit set');
  assert.equal(env.NOTION_API_KEY, undefined);
});

// ── UI predicate (S2-T6) ────────────────────────────────────────────────────

test('isUiDiff sees component/style changes, not lib or script changes', () => {
  assert.equal(isUiDiff(['src/components/ShowCard.tsx']), true);
  assert.equal(isUiDiff(['src/app/globals.css']), true);
  assert.equal(isUiDiff(['tailwind.config.js']), true);
  assert.equal(isUiDiff(['src/lib/format.ts']), false);
  assert.equal(isUiDiff(['scripts/lib/foo.js']), false);
  assert.equal(isUiDiff([]), false);
});

// An image swap changes the page as surely as a class name does. The first
// cut of this predicate missed public/ entirely and would have handed out a
// normal approve link for it (ship-check finding).
test('isUiDiff sees render-affecting assets outside src/', () => {
  assert.equal(isUiDiff(['public/images/hero.png']), true);
  assert.equal(isUiDiff(['public/logo.SVG']), true, 'case-insensitive extension');
  assert.equal(isUiDiff(['src/app/show/[slug]/opengraph-image.tsx']), true);
  assert.equal(isUiDiff(['public/data/show-lookup.json']), false, 'data under public/ is not a look change');
});

// The build env is a hand-maintained mirror of package.json's auth-aware
// build script. When that script gains or loses a flag, this fails loudly
// instead of the loop silently verifying a DIFFERENT build than the one that
// ships (ship-check finding: a second config surface that can drift).
test('BUILD_ENV feature flags match package.json build:ugc', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const script = pkg.scripts['build:ugc'] || '';
  const m = /NEXT_PUBLIC_FEATURES=([^\s]+)/.exec(script);
  assert.ok(m, 'build:ugc should still set NEXT_PUBLIC_FEATURES');
  const fromPkg = m[1].split(',').sort();
  const fromEnv = BUILD_ENV.NEXT_PUBLIC_FEATURES.split(',').sort();
  assert.deepEqual(fromEnv, fromPkg,
    'BUILD_ENV.NEXT_PUBLIC_FEATURES drifted from package.json build:ugc — the loop would verify a different build than ships');
});

test('hasSrcChange', () => {
  assert.equal(hasSrcChange(['src/lib/format.ts']), true);
  assert.equal(hasSrcChange(['scripts/x.js', 'docs/y.md']), false);
});

// ── workdir prep ────────────────────────────────────────────────────────────

test('prepareCheckWorkdir fills gaps only and never overwrites tracked files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-prep-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data', 'shows.json'), '{"from":"repo"}');
  fs.writeFileSync(path.join(repo, 'data', 'tracked.json'), '{"from":"repo"}');
  fs.writeFileSync(path.join(wt, 'data', 'tracked.json'), '{"from":"worktree"}');

  const linked = prepareCheckWorkdir(wt, repo);

  assert.ok(linked.includes(path.join('data', 'shows.json')), 'missing file was linked');
  assert.ok(linked.includes('node_modules'), 'node_modules was linked');
  assert.ok(!linked.includes(path.join('data', 'tracked.json')), 'existing file untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(wt, 'data', 'tracked.json'), 'utf8')).from, 'worktree');
  assert.equal(JSON.parse(fs.readFileSync(path.join(wt, 'data', 'shows.json'), 'utf8')).from, 'repo');
  // COPIED, not linked: implementer-authored check code must not get a
  // writable handle on the owner's private data repo (ship-check finding).
  assert.equal(fs.lstatSync(path.join(wt, 'data', 'shows.json')).isSymbolicLink(), false);
  fs.writeFileSync(path.join(wt, 'data', 'shows.json'), '{"from":"malicious-test"}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'data', 'shows.json'), 'utf8')).from, 'repo',
    'writing the worktree copy must not reach the source');
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), true, 'node_modules stays a link');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── resolveInstallRoot (BRO-3907) ────────────────────────────────────────────

test('resolveInstallRoot: a repo with its own node_modules is returned unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-root-'));
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  assert.equal(resolveInstallRoot(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveInstallRoot: a git WORKTREE with no node_modules of its own resolves to the main checkout that has one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-root-wt-'));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(path.join(main, 'node_modules'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: main });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: main });
  fs.writeFileSync(path.join(main, 'x.txt'), 'x');
  execFileSync('git', ['add', 'x.txt'], { cwd: main });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: main });

  // The worktree itself has no node_modules — resolveInstallRoot must find
  // the main checkout's via `git rev-parse --git-common-dir`, not just give up.
  // realpathSync on both sides: git's --path-format=absolute resolves macOS's
  // /tmp -> /private/tmp symlink, so a literal string compare against the
  // unresolved mkdtempSync path would spuriously fail on this platform alone.
  assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
  assert.equal(fs.realpathSync(resolveInstallRoot(wt)), fs.realpathSync(main));

  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main });
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveInstallRoot: a plain non-git directory with no node_modules fails closed to the input path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-root-plain-'));
  assert.equal(resolveInstallRoot(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveInstallRoot: a worktree whose MAIN checkout also lacks node_modules fails closed to the input path (never invents a phantom root)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-root-nomod-'));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: main });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: main });
  fs.writeFileSync(path.join(main, 'x.txt'), 'x');
  execFileSync('git', ['add', 'x.txt'], { cwd: main });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: main });

  assert.equal(resolveInstallRoot(wt), wt);

  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main });
  fs.rmSync(root, { recursive: true, force: true });
});

// ── runner ──────────────────────────────────────────────────────────────────

test('runSafeChecks runs the plan and reports pass/fail per check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-run-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'good.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'bad.js'), 'const = ;\n');

  const results = runSafeChecks({
    cwd: dir, changedFiles: ['scripts/good.js', 'scripts/bad.js'],
    isSafeCheckCommand: () => false, tier: 3,
  });
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.equal(byName['node --check scripts/good.js'].pass, true);
  assert.equal(byName['node --check scripts/bad.js'].pass, false);
  assert.ok(byName['node --check scripts/bad.js'].detail.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A tier-3 diff nothing can check is UNVERIFIED. It used to reach the owner
// wearing a green PASS badge with an empty check list (ship-check finding).
test('a tier-3 diff with no runnable check fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-empty-'));
  const results = runSafeChecks({
    cwd: dir, changedFiles: ['scripts/lib/config.json'], isSafeCheckCommand: () => false, tier: 3, existsFn: never,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'no-checks');
  assert.equal(results[0].pass, false);
  assert.match(results[0].detail, /scripts\/lib\/config\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an inert (docs/tests) diff is still allowed to have nothing to run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-inert-'));
  assert.deepEqual(runSafeChecks({ cwd: dir, changedFiles: ['docs/x.md', 'memory/y.md'], isSafeCheckCommand: () => false, tier: 3, existsFn: never }), []);
  assert.deepEqual(runSafeChecks({ cwd: dir, changedFiles: ['scripts/lib/config.json'], isSafeCheckCommand: () => false, tier: 1, existsFn: never }), [],
    'tier 1 is unaffected');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runSafeChecks cleans up the throwaway HOME it created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-home-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'good.js'), 'const x = 1;\n');
  // Track the exact dir(s) THIS call creates instead of counting every
  // auto-checks-home-* in the shared os.tmpdir(): other processes (parallel
  // sessions, land.js gauntlets) create and delete same-prefixed dirs
  // concurrently, which flipped a global count and false-blocked unrelated
  // landings (BRO-3929).
  const created = [];
  const realMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => {
    const p = realMkdtemp(prefix, ...rest);
    if (path.basename(String(prefix)).startsWith('auto-checks-home-')) created.push(p);
    return p;
  };
  try {
    runSafeChecks({ cwd: dir, changedFiles: ['scripts/good.js'], isSafeCheckCommand: () => false, tier: 3 });
  } finally {
    fs.mkdtempSync = realMkdtemp;
  }
  assert.ok(created.length > 0, 'runSafeChecks created a throwaway HOME (spy must see it, or this test proves nothing)');
  for (const p of created) assert.equal(fs.existsSync(p), false, `fake HOME left behind: ${p}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runSafeChecks fails closed on an unsafe checkableDone instead of dropping it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-card-'));
  const results = runSafeChecks({
    cwd: dir, changedFiles: ['docs/x.md'], checkableDone: 'rm -rf /',
    isSafeCheckCommand: () => false, tier: 3,
  });
  assert.deepEqual(results, [{ name: 'card-check', pass: false, detail: 'checkableDone failed safe-form validation: rm -rf /' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runSafeChecks executes a validated card check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-card2-'));
  fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
  const results = runSafeChecks({
    cwd: dir, changedFiles: ['docs/x.md'], checkableDone: 'test -f present.txt',
    isSafeCheckCommand: () => true, tier: 1,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].pass, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── dependency rule ─────────────────────────────────────────────────────────

// Source-text assertion is unavoidable here (task #1432 audit): "this module
// has zero non-builtin dependencies" is a structural property of the source,
// not an input/output behavior reachable through autonomous-checks.js's
// public functions — there's no call you can make to observe what it
// require()d. Unlike the cmux-launch.js/dispatch-ledger incident this audit
// was triggered by, the regex here doesn't pin a specific code SHAPE (an
// exact statement form or ordering) — it enumerates every require() call
// argument generically and only fails when one resolves to something outside
// the builtins allow-list, so reordering, renaming, or reformatting actual
// require() call sites cannot break it; only adding a real new dependency
// can. Caveat (found in review): it scans raw text, not an AST, so a
// `require('...')` substring inside a comment or string literal would also
// trip it — an acceptable false-positive-toward-safety tradeoff for a file
// with no such text today, not a guarantee that literally nothing else can
// touch this test.
test('autonomous-checks.js requires node built-ins only', () => {
  const src = fs.readFileSync(new URL('./autonomous-checks.js', import.meta.url), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const builtins = new Set(['fs', 'os', 'path', 'child_process', 'crypto', 'util']);
  for (const r of requires) {
    const bare = r.startsWith('node:') ? r.slice(5) : r;
    assert.ok(builtins.has(bare), `unexpected non-builtin require: ${r} (the shared runner must stay dependency-free)`);
  }
});
