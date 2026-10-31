// Non-production hosts (preview, demo) must emit noindex in the robots meta tag,
// matching robots.txt. Until BRO-5007, layout.tsx hardcoded `index: true`, so
// demo.broadwayscorecard.com said "index, follow" while its robots.txt said
// Disallow: /. Pages that set `index: true` themselves overrode the layout the
// same way, so the source scan below keeps that from coming back.
//
// Run via `npx tsx --test` (tests/unit-test-manifest-tsx.txt); imports the real
// helper and robots().
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isIndexableDeploy, siteRobots } from '../../src/lib/indexable-deploy';
import robots from '../../src/app/robots';

const ROOT = path.resolve(__dirname, '..', '..');

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.VERCEL_ENV;
  if (value === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
}

test('production (and local builds) are indexable', () => {
  assert.deepEqual(withEnv('production', siteRobots), { index: true, follow: true });
  assert.deepEqual(withEnv(undefined, siteRobots), { index: true, follow: true });
});

test('preview and demo builds emit noindex, nofollow', () => {
  for (const env of ['preview', 'development']) {
    assert.equal(withEnv(env, isIndexableDeploy), false, env);
    assert.deepEqual(withEnv(env, siteRobots), { index: false, follow: false }, env);
  }
});

test('robots.txt and the meta tag agree on every environment', () => {
  for (const env of ['production', 'preview', 'development', undefined]) {
    const txt = withEnv(env, robots);
    const rules = Array.isArray(txt.rules) ? txt.rules : [txt.rules];
    const blocksAll = rules.some((r) => r.userAgent === '*' && r.disallow === '/');
    const meta = withEnv(env, siteRobots) as { index: boolean };
    assert.equal(meta.index, !blocksAll, `VERCEL_ENV=${env}`);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

test('layout uses siteRobots() and no page hardcodes index: true', () => {
  const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
  assert.match(layout, /robots:\s*siteRobots\(\)/);
  const offenders = walk(path.join(ROOT, 'src/app'))
    .filter((f) => /\bindex:\s*true\b/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, [], 'a page-level `index: true` overrides the noindex on preview/demo hosts; inherit the layout instead');
});
