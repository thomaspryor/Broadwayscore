import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectBuildScriptDependencies } = require('./build-script-dependencies.js');
const { isBuildCodePath, selectRecheckScope, makeVerifiedBaseChecks } = require('./land-branch.js');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-scripts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  }
  return root;
}

test('traces site imports, CommonJS aliases, transitive helpers, config and prebuild without executing code', t => {
  const root = fixture(t, {
    'src/app/page.tsx': `import { x } from '@/lib/site'; export default () => x;`,
    'src/lib/site.ts': `import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); export const x = load('../../scripts/lib/site');`,
    'scripts/lib/site.js': `throw Error('must not execute'); module.exports = require('./shared');`,
    'scripts/lib/shared.js': `module.exports = require('./site');`,
    'scripts/prebuild.sh': `# node scripts/unused.js\nnode scripts/generate.js\nbash scripts/nested.sh\n`,
    'scripts/nested.sh': 'node scripts/other.js',
    'scripts/generate.js': `require('./lib/generated');`,
    'scripts/lib/generated.js': 'module.exports = 1;',
    'scripts/other.js': 'module.exports = 2;',
    'next.config.js': `module.exports = require('./scripts/lib/config');`,
    'scripts/lib/config.js': 'module.exports = {};',
    'scripts/lib/land-local-check.js': 'module.exports = {};',
    'src/lib/unloaded.test.mjs': `require('../../scripts/test-only');`,
  });
  const graph = collectBuildScriptDependencies(root);
  assert.deepEqual([...graph].sort(), ['scripts/generate.js', 'scripts/lib/config.js', 'scripts/lib/generated.js', 'scripts/lib/shared.js', 'scripts/lib/site.js', 'scripts/nested.sh', 'scripts/other.js', 'scripts/prebuild.sh']);
  assert.equal(isBuildCodePath('scripts/lib/site.js', graph), true);
  assert.equal(isBuildCodePath('scripts/lib/land-local-check.js', graph), false);
  assert.equal(isBuildCodePath('scripts/lib/new-manifest.json', graph), true, 'non-code inputs stay conservative');
});

test('unknown dependency graphs retain the full scripts classification', t => {
  for (const source of [`require(variable)`, `import(variable)`, `require('./missing')`, `const broken = ;`, `eval(code)`, `const load = createRequire('/other/base'); load('./helper');`]) {
    const root = fixture(t, { 'src/app/page.ts': source });
    const graph = collectBuildScriptDependencies(root);
    assert.equal(graph, null, source);
    assert.equal(isBuildCodePath('scripts/lib/worker.js', graph), true);
  }
  assert.equal(collectBuildScriptDependencies(path.join(os.tmpdir(), 'no-build-tree-here')), null);
  const root = fixture(t, { 'scripts/prebuild.sh': 'node "$BUILD_SCRIPT"' });
  assert.equal(collectBuildScriptDependencies(root), null);
});

test('package build commands, renamed createRequire imports and require aliases retain dependencies', t => {
  const root = fixture(t, {
    'package.json': JSON.stringify({ scripts: { build: 'npm run generate && next build', generate: 'node scripts/custom.mjs' } }),
    'scripts/custom.mjs': `import { createRequire as makeLoader } from 'node:module'; const load = makeLoader(import.meta.url); const otherLoad = load; otherLoad('./lib/custom');`,
    'scripts/lib/custom.js': `module.exports = require.resolve('./resolved');`,
    'scripts/lib/resolved.js': 'module.exports = 1;',
  });
  assert.deepEqual([...collectBuildScriptDependencies(root)].sort(), ['scripts/custom.mjs', 'scripts/lib/custom.js', 'scripts/lib/resolved.js']);
});

test('computed JSON data imports and absent generated manifests do not load script code', t => {
  const root = fixture(t, {
    'src/lib/data.ts': `import data from '../../data/generated.json'; const x = require(path.join(dataDir, 'shows.json'));`,
  });
  assert.deepEqual([...collectBuildScriptDependencies(root)], []);
});

test('small re-check skips builds for fleet scripts and bot assets but retains site builds and full overlap checks', t => {
  const root = fixture(t, {
    'src/app/page.ts': `require('../../scripts/lib/site');`,
    'scripts/lib/site.js': 'module.exports = 1;',
  });
  const buildScripts = collectBuildScriptDependencies(root);
  const scope = intervening => selectRecheckScope({ ancestor: true, changedFiles: ['src/app/other.tsx'], intervening, buildScripts });
  for (const files of [['scripts/lib/cmux-socket-mode-repair.js'], ['scripts/lib/land-local-check.js', 'public/opening-night-status.json'], ['scripts/lib/linear-drain-parked.js', 'public/images/shows/show/poster.jpg']]) {
    assert.equal(scope(files).build, false);
    assert.equal(scope(files).mode, 'small');
  }
  for (const files of [['scripts/lib/site.js'], ['src/app/page.ts'], ['next.config.js'], ['package-lock.json']]) assert.equal(scope(files).build, true);
  assert.equal(scope(['src/app/other.tsx']).mode, 'full');
  assert.equal(scope(['src/app/other.tsx']).build, true);
});

test('verified-base caller derives the graph from the merged tree and passes the decision to the real checks seam', t => {
  const root = fixture(t, {
    'src/app/page.ts': 'export default 1;',
    'scripts/lib/worker.js': 'module.exports = 1;',
  });
  let seen;
  const checks = makeVerifiedBaseChecks({
    verifiedBase: 'a'.repeat(40), prepare: () => [],
    checks: o => { seen = o; return []; },
    git: args => args[0] === 'merge-base' ? '' : args.at(-1).endsWith('...HEAD') ? 'src/app/page.ts' : 'scripts/lib/worker.js',
  });
  checks({ cwd: root, baseSha: 'b'.repeat(40), changedFiles: ['src/app/page.ts'] });
  assert.equal(seen.recheckScope.mode, 'small');
  assert.equal(seen.recheckScope.build, false);
});
