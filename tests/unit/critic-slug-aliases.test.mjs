// Critic-slug alias registry + redirect emission (2026 data audit, S5-T9).
//
// Requires the real module (CLAUDE.md §15) and points it at temp files via the
// per-call `aliasesPath` option / the CRITIC_SLUG_ALIASES_PATH env var — never
// at data/ (core data, §11). The end-to-end cases run the real
// scripts/build-slug-redirects.js against a temp shows.json + registry through
// its SLUG_REDIRECTS_SHOWS_PATH / SLUG_REDIRECTS_OUT_DIR overrides, so the
// tracked data/slug-redirects*.json files are never touched.
//
// Run: node --test tests/unit/critic-slug-aliases.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../../scripts/lib/critic-slug-aliases.js');
const {
  CRITIC_SLUG_ALIASES_PATH,
  CRITIC_REDIRECT_PREFIX,
  normalizeCriticSlugAliases,
  loadCriticSlugAliases,
  flattenCriticSlugAliases,
  buildCriticRedirectEntries,
} = mod;

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SEED_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'critic-slug-aliases.seed.json');
const SCRIPT = join(REPO_ROOT, 'scripts', 'build-slug-redirects.js');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'critic-slug-aliases-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exported contract is exactly the six documented names', () => {
  assert.deepEqual(Object.keys(mod).sort(), [
    'CRITIC_REDIRECT_PREFIX',
    'CRITIC_SLUG_ALIASES_PATH',
    'buildCriticRedirectEntries',
    'flattenCriticSlugAliases',
    'loadCriticSlugAliases',
    'normalizeCriticSlugAliases',
  ]);
  assert.match(CRITIC_SLUG_ALIASES_PATH, /[\\/]data[\\/]critic-slug-aliases\.json$/);
  assert.equal(CRITIC_REDIRECT_PREFIX, 'critic:');
});

test('loadCriticSlugAliases: missing file is an empty registry, not an error', () => {
  withTmp((dir) => {
    assert.deepEqual(loadCriticSlugAliases({ aliasesPath: join(dir, 'absent.json') }), {});
  });
});

test('loadCriticSlugAliases: empty file is an empty registry', () => {
  withTmp((dir) => {
    const p = join(dir, 'aliases.json');
    writeFileSync(p, '\n');
    assert.deepEqual(loadCriticSlugAliases({ aliasesPath: p }), {});
  });
});

test('loadCriticSlugAliases: malformed JSON and a non-object root are loud, never silently empty', () => {
  withTmp((dir) => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"jose-sol-s": "jose-solis",');
    assert.throws(() => loadCriticSlugAliases({ aliasesPath: bad }), /not valid JSON/);
    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[["jose-sol-s", "jose-solis"]]');
    assert.throws(() => loadCriticSlugAliases({ aliasesPath: arr }), /must be a JSON object/);
  });
});

test('loadCriticSlugAliases: normalizes keys/values, ignores _annotations, honours the env-var override', () => {
  withTmp((dir) => {
    const p = join(dir, 'aliases.json');
    writeFileSync(p, JSON.stringify({ _note: 'template', ' Jose-Sol-S ': 'Jose-Solis', 'bad-value': 7, 'empty-value': '' }));
    const prev = process.env.CRITIC_SLUG_ALIASES_PATH;
    process.env.CRITIC_SLUG_ALIASES_PATH = p;
    try {
      assert.deepEqual(loadCriticSlugAliases(), { 'jose-sol-s': 'jose-solis' });
    } finally {
      if (prev === undefined) delete process.env.CRITIC_SLUG_ALIASES_PATH;
      else process.env.CRITIC_SLUG_ALIASES_PATH = prev;
    }
  });
});

test('normalizeCriticSlugAliases: reports each skipped entry with a reason instead of throwing', () => {
  const { aliases, skipped } = normalizeCriticSlugAliases({
    _meta: { generated: true },
    'a-b': 'C-D ',
    'A-B': 'other',
    'no-target': null,
    '  ': 'x',
    num: 3,
  });
  assert.deepEqual(aliases, { 'a-b': 'c-d' });
  assert.deepEqual(skipped.map((s) => s.key).sort(), ['  ', 'A-B', 'no-target', 'num']);
  assert.match(skipped.find((s) => s.key === 'A-B').reason, /duplicate/);
  assert.match(skipped.find((s) => s.key === 'num').reason, /non-empty string/);
  assert.throws(() => normalizeCriticSlugAliases(null), /must be a JSON object/);
  assert.throws(() => normalizeCriticSlugAliases([]), /got array/);
});

test('flattenCriticSlugAliases: chains resolve to the terminal slug; self-maps and cycles are dropped', () => {
  const { aliases, dropped } = flattenCriticSlugAliases({
    'old-a': 'mid-b',
    'mid-b': 'final-c',
    'jose-sol-s': 'jose-solis',
    same: 'same',
    'loop-x': 'loop-y',
    'loop-y': 'loop-x',
  });
  assert.deepEqual(aliases, { 'old-a': 'final-c', 'mid-b': 'final-c', 'jose-sol-s': 'jose-solis' });
  assert.deepEqual(dropped.map((d) => d.slug).sort(), ['loop-x', 'loop-y', 'same']);
  assert.match(dropped.find((d) => d.slug === 'same').reason, /itself/);
  assert.match(dropped.find((d) => d.slug === 'loop-x').reason, /cycle/);
  assert.deepEqual(flattenCriticSlugAliases({}), { aliases: {}, dropped: [] });
});

test('buildCriticRedirectEntries: every entry is namespaced under the prefix and permanent (never "~")', () => {
  const entries = buildCriticRedirectEntries({ 'jose-sol-s': 'jose-solis', 'rafer-guzm-n': 'rafer-guzman' });
  assert.deepEqual(entries, { 'critic:jose-sol-s': 'jose-solis', 'critic:rafer-guzm-n': 'rafer-guzman' });
  assert.ok(Object.values(entries).every((v) => !v.startsWith('~')));
  assert.deepEqual(buildCriticRedirectEntries({}), {});
});

test('seed template loads through the real loader, flattens with nothing dropped, and carries the documented seeds', () => {
  const aliases = loadCriticSlugAliases({ aliasesPath: SEED_PATH });
  assert.equal(aliases['jose-sol-s'], 'jose-solis');
  assert.equal(aliases['juan-a-ram-rez'], 'juan-a-ramirez');
  assert.equal(aliases['rafer-guzm-n'], 'rafer-guzman');
  assert.ok(!('_note' in aliases), '_note annotation must not become a redirect');
  const { aliases: flat, dropped } = flattenCriticSlugAliases(aliases);
  assert.deepEqual(dropped, []);
  assert.deepEqual(flat, aliases);
});

// ── end to end: the real script against temp inputs ─────────────────────────

const FIXTURE_SHOWS = {
  _meta: { lastUpdated: '2026-09-28T00:00:00.000Z' },
  shows: [
    { id: 'hamilton-2015', slug: 'hamilton-2015' },
    { id: 'hamilton-west-end-2017', slug: 'hamilton-west-end' },
    {
      id: 'the-emporium-off-broadway-2025',
      slug: 'the-emporium-off-broadway',
      aliases: ['thornton-wilders-the-emporium-off-broadway-2026', 'thornton-wilders-the-emporium-off-broadway'],
    },
  ],
};

function runScript(dir, registryPath) {
  writeFileSync(join(dir, 'shows.json'), JSON.stringify(FIXTURE_SHOWS));
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SLUG_REDIRECTS_SHOWS_PATH: join(dir, 'shows.json'),
      SLUG_REDIRECTS_OUT_DIR: dir,
      CRITIC_SLUG_ALIASES_PATH: registryPath,
    },
  });
  if (res.status !== 0) return res;
  return {
    ...res,
    compact: JSON.parse(readFileSync(join(dir, 'slug-redirects-compact.json'), 'utf8')),
    full: JSON.parse(readFileSync(join(dir, 'slug-redirects.json'), 'utf8')),
  };
}

test('build-slug-redirects.js: critic aliases land in the compact map under the prefix, beside the show redirects', () => {
  withTmp((dir) => {
    const registry = join(dir, 'critic-slug-aliases.json');
    writeFileSync(
      registry,
      JSON.stringify({
        _note: 'fixture',
        'Jose-Sol-S': 'jose-solis',
        'old-spelling': 'mid-slug',
        'mid-slug': 'final-slug',
        'loop-a': 'loop-b',
        'loop-b': 'loop-a',
      })
    );
    const res = runScript(dir, registry);
    assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
    const { compact, full, stdout, stderr } = res;

    // Show side is untouched by the critic work.
    assert.equal(compact.hamilton, 'hamilton-2015');
    assert.equal(compact['hamilton-west-end-2017'], 'hamilton-west-end');
    assert.equal(compact['the-emporium-off-broadway-2025'], 'the-emporium-off-broadway');
    assert.equal(compact['thornton-wilders-the-emporium-off-broadway-2026'], 'the-emporium-off-broadway');
    assert.equal(compact['thornton-wilders-the-emporium-off-broadway'], 'the-emporium-off-broadway');

    // Critic side: prefixed, lowercased, chains flattened, cycle dropped.
    assert.equal(compact['critic:jose-sol-s'], 'jose-solis');
    assert.equal(compact['critic:old-spelling'], 'final-slug');
    assert.equal(compact['critic:mid-slug'], 'final-slug');
    assert.ok(!('critic:loop-a' in compact) && !('critic:loop-b' in compact), 'a cycle must never be emitted');
    assert.deepEqual(full.criticRedirects, { 'jose-sol-s': 'jose-solis', 'old-spelling': 'final-slug', 'mid-slug': 'final-slug' });
    assert.equal(full._meta.totalCriticRedirects, 3);
    assert.ok(!Object.keys(full.redirects).some((k) => k.startsWith(CRITIC_REDIRECT_PREFIX)), 'show map stays free of critic keys');
    assert.match(stdout, /3 critic aliases/);
    assert.match(stderr, /cycle/);
  });
});

test('build-slug-redirects.js: a missing registry emits zero critic entries and still exits 0', () => {
  withTmp((dir) => {
    const res = runScript(dir, join(dir, 'absent.json'));
    assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
    const { compact, full, stdout } = res;
    assert.deepEqual(Object.keys(compact).filter((k) => k.startsWith(CRITIC_REDIRECT_PREFIX)), []);
    assert.deepEqual(full.criticRedirects, {});
    assert.equal(full._meta.totalCriticRedirects, 0);
    assert.equal(compact.hamilton, 'hamilton-2015');
    assert.match(stdout, /0 critic aliases/);
  });
});

test('build-slug-redirects.js: a malformed registry fails prebuild loudly', () => {
  withTmp((dir) => {
    const registry = join(dir, 'critic-slug-aliases.json');
    writeFileSync(registry, '{ not json');
    const res = runScript(dir, registry);
    assert.notEqual(res.status, 0, 'a malformed registry must not produce a redirect map');
    assert.match(res.stderr, /not valid JSON/);
  });
});
