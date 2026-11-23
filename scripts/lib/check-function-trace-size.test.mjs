// BRO-8154: the post-build trace size check. Requires the real functions
// (CLAUDE.md §15), runs them on a fixture .next/server tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { sizeTrace, scanTraces } = require('./check-function-trace-size.js');
const SCRIPT = join(import.meta.dirname, 'check-function-trace-size.js');
const KB = 1024;

test('sizeTrace sums existing files, dedupes, counts missing, ranks the top files', () => {
  const sizes = { '/r/a': 100, '/r/b': 300, '/r/c': 200, '/r/d': 50 };
  const r = sizeTrace(
    { files: ['a', 'b', 'a', 'c', 'gone', 'd'] }, '/r', (p) => (p in sizes ? sizes[p] : null), 2);
  assert.equal(r.totalBytes, 650);
  assert.equal(r.fileCount, 4);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.top.map((f) => f.bytes), [300, 200]);
});

test('sizeTrace resolves paths against the json directory and tolerates an empty trace', () => {
  const seen = [];
  sizeTrace({ files: ['../../node_modules/x/index.js'] }, '/r/.next/server/app', (p) => { seen.push(p); return 1; });
  assert.deepEqual(seen, ['/r/.next/node_modules/x/index.js']);
  assert.equal(sizeTrace({}, '/r', () => 1).totalBytes, 0);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trace-size-'));
  const server = join(root, '.next', 'server', 'app', 'api');
  mkdirSync(server, { recursive: true });
  mkdirSync(join(root, 'node_modules', 'big'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'big', 'blob.bin'), Buffer.alloc(300 * KB));
  writeFileSync(join(root, 'small.js'), Buffer.alloc(10 * KB));
  const trace = (files) => JSON.stringify({ version: 1, files });
  writeFileSync(join(server, 'under.js.nft.json'), trace(['../../../../small.js']));
  writeFileSync(join(server, 'over.js.nft.json'), trace(['../../../../small.js', '../../../../node_modules/big/blob.bin']));
  return root;
}

test('scanTraces flags only the function over the limit, with a readable name', () => {
  const root = fixture();
  try {
    const res = scanTraces(join(root, '.next', 'server'), { limitBytes: 100 * KB });
    const byName = Object.fromEntries(res.map((r) => [r.name, r]));
    assert.equal(byName['app/api/under'].over, false);
    assert.equal(byName['app/api/over'].over, true);
    assert.equal(byName['app/api/over'].top[0].bytes, 300 * KB);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanTraces boundary: exactly at the limit passes, one byte over fails', () => {
  const root = fixture();
  try {
    const dir = join(root, '.next', 'server');
    const exact = scanTraces(dir, { limitBytes: 310 * KB }).find((r) => r.name === 'app/api/over');
    assert.equal(exact.totalBytes, 310 * KB);
    assert.equal(exact.over, false);
    assert.equal(scanTraces(dir, { limitBytes: 310 * KB - 1 }).find((r) => r.name === 'app/api/over').over, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanTraces also scans shared runtime traces at the .next root', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.next', 'next-server.js.nft.json'), JSON.stringify({ files: ['../node_modules/big/blob.bin'] }));
    const over = spawnSync('node', [SCRIPT, join(root, '.next'), '--limit-mb=0.1'], { encoding: 'utf8' });
    assert.match(over.stdout, /FAIL \.\.\/next-server/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI exits 1 and names the biggest files when over, 0 when under, 2 with no build', () => {
  const root = fixture();
  try {
    const next = join(root, '.next');
    const over = spawnSync('node', [SCRIPT, next, '--limit-mb=0.1'], { encoding: 'utf8' });
    assert.equal(over.status, 1);
    assert.match(over.stdout, /FAIL app\/api\/over/);
    assert.match(over.stdout, /node_modules\/big\/blob\.bin/);
    const under = spawnSync('node', [SCRIPT, next, '--limit-mb=1'], { encoding: 'utf8' });
    assert.equal(under.status, 0);
    // Fail closed: traces whose files are all missing must not read as 0 MB.
    const bad = join(root, '.next', 'server', 'app', 'api', 'broken.js.nft.json');
    writeFileSync(bad, JSON.stringify({ version: 1, files: ['nope1.js', 'nope2.js'] }));
    const broken = spawnSync('node', [SCRIPT, next, '--limit-mb=1'], { encoding: 'utf8' });
    assert.equal(broken.status, 0, 'one broken trace among healthy ones stays under the ratio');
    const emptyRoot = mkdtempSync(join(tmpdir(), 'trace-empty-'));
    mkdirSync(join(emptyRoot, '.next', 'server'), { recursive: true });
    assert.equal(spawnSync('node', [SCRIPT, join(emptyRoot, '.next')], { encoding: 'utf8' }).status, 2);
    mkdirSync(join(emptyRoot, '.next', 'server', 'app'), { recursive: true });
    writeFileSync(join(emptyRoot, '.next', 'server', 'app', 'x.js.nft.json'), JSON.stringify({ files: ['a', 'b'] }));
    assert.equal(spawnSync('node', [SCRIPT, join(emptyRoot, '.next')], { encoding: 'utf8' }).status, 2);
    rmSync(emptyRoot, { recursive: true, force: true });
    // Unreadable trace, boundary (> not >=), space-form limit, bad limit, annotation on fail-closed exits.
    const corruptRoot = mkdtempSync(join(tmpdir(), 'trace-corrupt-'));
    mkdirSync(join(corruptRoot, '.next', 'server', 'app'), { recursive: true });
    writeFileSync(join(corruptRoot, '.next', 'server', 'app', 'c.js.nft.json'), '{not json');
    const corrupt = spawnSync('node', [SCRIPT, join(corruptRoot, '.next')], { encoding: 'utf8' });
    assert.equal(corrupt.status, 2);
    assert.match(corrupt.stdout, /::warning title=Trace size check could not run::/);
    rmSync(corruptRoot, { recursive: true, force: true });
    const spaced = spawnSync('node', [SCRIPT, next, '--limit-mb', '0.1'], { encoding: 'utf8' });
    assert.equal(spaced.status, 1, 'space-form limit applies and is not read as the .next dir');
    assert.match(over.stdout, /::warning title=Function trace over/);
    assert.equal(spawnSync('node', [SCRIPT, next, '--limit-mb=abc'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('node', [SCRIPT, next, '--limit-mb='], { encoding: 'utf8' }).status, 2);
    const none = spawnSync('node', [SCRIPT, join(root, 'nope')], { encoding: 'utf8' });
    assert.equal(none.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
