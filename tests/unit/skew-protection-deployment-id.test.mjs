import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '../..');
const configPath = join(root, 'next.config.js');

function buildEnv(overrides = {}) {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
  for (const key of ['VERCEL', 'VERCEL_DEPLOYMENT_ID', 'NEXT_DEPLOYMENT_ID', 'GITHUB_PAGES']) delete env[key];
  return { ...env, ...overrides };
}

function readConfig(env) {
  return JSON.parse(execFileSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(configPath)})))`,
  ], { env: buildEnv(env), encoding: 'utf8' }));
}

test('prebuilt Vercel builds get a unique, valid custom deployment ID', () => {
  const first = readConfig({ VERCEL: '1' }).deploymentId;
  const second = readConfig({ VERCEL: '1' }).deploymentId;
  assert.equal(typeof first, 'string', 'vercel build has no VERCEL_DEPLOYMENT_ID; config must supply one');
  assert.match(first, /^[A-Za-z0-9_-]{1,32}$/);
  assert.ok(!first.startsWith('dpl_'), 'dpl_ is reserved for Vercel-assigned IDs');
  assert.notEqual(first, second, 'rebuilding the same commit must get a new ID');
});

test('explicit deployment IDs are preserved, with Next environment override taking precedence', () => {
  assert.equal(readConfig({ VERCEL_DEPLOYMENT_ID: 'dpl_native' }).deploymentId, 'dpl_native');
  assert.equal(readConfig({ NEXT_DEPLOYMENT_ID: 'custom-next-id', VERCEL_DEPLOYMENT_ID: 'dpl_native' }).deploymentId, 'custom-next-id');
});

test('ordinary local builds do not get a Vercel deployment ID', () => {
  assert.equal(readConfig().deploymentId, undefined);
});

test('a production build emits the same dpl ID in JavaScript and CSS URLs on every page', { timeout: 240_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-skew-'));
  try {
    symlinkSync(realpathSync(join(root, 'node_modules')), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }));
    // Load the real build config, keeping the test small and independent of private data.
    writeFileSync(join(dir, 'next.config.js'), `
      const config = require(${JSON.stringify(configPath)});
      module.exports = { ...config, outputFileTracingRoot: __dirname,
        outputFileTracingIncludes: {}, outputFileTracingExcludes: {},
        experimental: { ...config.experimental, cpus: 1 } };
    `);
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app/layout.js'), `import './style.css';
      export default function Layout({ children }) { return <html><body>{children}</body></html>; }`);
    writeFileSync(join(dir, 'app/style.css'), 'body { margin: 0; }');
    // Published data is tracked, so these real cases also work on a fresh checkout.
    const { shows } = JSON.parse(readFileSync(join(root, 'public/data/mobile-shows.json'), 'utf8'));
    const samples = ['open', 'closed', 'previews'].map((status) => {
      const show = shows.find((show) => show.st === status);
      assert.ok(show, `published data must include a ${status} case`);
      return { route: status === 'open' ? '' : status, show };
    });
    for (const { route, show } of samples) {
      const pageDir = join(dir, 'app', route);
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'page.js'), `export default function Page() { return <main>{${JSON.stringify(show.t)}}</main>; }`);
    }
    const major = Number(require('next/package.json').version.split('.')[0]);
    execFileSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', ...(major >= 16 ? ['--webpack'] : [])], {
      cwd: dir, env: buildEnv({ VERCEL: '1' }), encoding: 'utf8', timeout: 210_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const builtConfig = JSON.parse(readFileSync(join(dir, '.next/required-server-files.json'), 'utf8')).config;
    // Next 16 publishes this for the Vercel builder to put in .vercel/output/config.json.
    if (major >= 16) {
      const routes = JSON.parse(readFileSync(join(dir, '.next/routes-manifest.json'), 'utf8'));
      assert.equal(routes.deploymentId, builtConfig.deploymentId);
    }
    const allAssets = [];
    for (const { route, show } of samples) {
      const html = readFileSync(join(dir, '.next/server/app', `${route || 'index'}.html`), 'utf8');
      const assets = [...html.matchAll(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/g)].map((m) => m[1]);
      const protectedCount = assets.filter((asset) => builtConfig.deploymentId && new URL(asset.replaceAll('&amp;', '&'), 'https://example.test').searchParams.get('dpl') === builtConfig.deploymentId).length;
      t.diagnostic(`${show.id} (${show.st}): ${protectedCount}/${assets.length} static asset references carry the build deployment ID`);
      assert.ok(assets.some((url) => url.includes('.js')), `${route}: must exercise JavaScript`);
      assert.ok(assets.some((url) => url.includes('.css')), `${route}: must exercise CSS`);
      allAssets.push(...assets);
    }
    assert.ok(builtConfig.deploymentId, 'production build must retain its deployment ID');
    for (const asset of allAssets) {
      assert.equal(new URL(asset.replaceAll('&amp;', '&'), 'https://example.test').searchParams.get('dpl'), builtConfig.deploymentId, asset);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
