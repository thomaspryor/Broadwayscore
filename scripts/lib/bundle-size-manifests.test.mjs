import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseBuildManifests } = require('./bundle-size-manifests.js');

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bsm-'));
  fs.mkdirSync(path.join(d, 'static/chunks'), { recursive: true });
  fs.mkdirSync(path.join(d, 'server/app/show'), { recursive: true });
  const blob = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251));
  fs.writeFileSync(path.join(d, 'static/chunks/a.js'), blob(4000));
  fs.writeFileSync(path.join(d, 'static/chunks/b.js'), blob(9000));
  const page = (...c) => c.map((x) => `<script src="/_next/static/chunks/${x}.js" async=""></script>`).join('');
  fs.writeFileSync(path.join(d, 'server/app/index.html'), page('a'));
  fs.writeFileSync(path.join(d, 'server/app/show/x.html'), page('a', 'b'));
  fs.writeFileSync(path.join(d, 'prerender-manifest.json'), JSON.stringify({ routes: { '/': { srcRoute: '/' }, '/show/x': { srcRoute: '/show/[slug]' }, '/show/y': { srcRoute: '/show/[slug]' } } }));
  return d;
}

test('First Load JS is the gzip sum of the prerendered page scripts, keyed by source route', () => {
  const d = fixture();
  const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(d, 'static/chunks', f))).length;
  const r = parseBuildManifests(d);
  assert.deepEqual(Object.keys(r.pages).sort(), ['/', '/show/[slug]']);
  assert.equal(r.pages['/'], Math.round((gz('a.js') / 1024) * 10) / 10);
  assert.equal(r.pages['/show/[slug]'], Math.round(((gz('a.js') + gz('b.js')) / 1024) * 10) / 10);
  assert.equal(r.sharedJS, r.pages['/']);
});
