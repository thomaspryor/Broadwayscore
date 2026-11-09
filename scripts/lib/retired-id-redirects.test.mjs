// BRO-7210: retired "duplicate of X" ids redirect to X's slug.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveRetiredIdRedirects } = require('./retired-id-redirects.js');
const shows = [
  { id: 'jena-motherfucker-2026', slug: 'jena-motherfucker' },
  { id: 'live-2026', slug: 'live-2026' },
];
const retired = [
  { id: 'motherfucker-2026', reason: 'duplicate of jena-motherfucker-2026 (same venue/run); zero reviews' },
  { id: 'cap-2026', reason: 'Duplicate of jena-motherfucker-2026: same production' },
  { id: 'live-2026', reason: 'duplicate of jena-motherfucker-2026' },
  { id: 'gone-2026', reason: 'duplicate of not-a-show-2026' },
  { id: 'other-2026', reason: 'regional co-production, not a tour' },
  { id: 'taken-2026', reason: 'duplicate of jena-motherfucker-2026' },
];

test('maps duplicate-of retirees to the kept slug; skips live, unknown, non-duplicate and taken', () => {
  const r = deriveRetiredIdRedirects(retired, shows, new Set(['taken-2026']));
  assert.deepEqual(r, {
    'motherfucker-2026': { target: 'jena-motherfucker', permanent: true },
    'cap-2026': { target: 'jena-motherfucker', permanent: true },
  });
});

test('build-slug-redirects emits them end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-redir-'));
  try {
    fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows }));
    fs.writeFileSync(path.join(dir, 'retired-show-ids.json'), JSON.stringify(retired));
    execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'build-slug-redirects.js')], {
      env: { ...process.env, SLUG_REDIRECTS_SHOWS_PATH: path.join(dir, 'shows.json'), SLUG_REDIRECTS_OUT_DIR: dir,
        SLUG_REDIRECTS_CAST_MANIFEST_PATH: path.join(dir, 'none.json'), SLUG_REDIRECTS_COMPLEXES_DIR: dir },
      stdio: 'pipe',
    });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'slug-redirects.json'), 'utf8'));
    assert.equal(out.redirects['motherfucker-2026'].target, 'jena-motherfucker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live data: every retired duplicate-of id with a live kept show resolves', () => {
  const D = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data');
  if (!fs.existsSync(path.join(D, 'retired-show-ids.json')) || !fs.existsSync(path.join(D, 'shows.json'))) return;
  const live = JSON.parse(fs.readFileSync(path.join(D, 'shows.json'), 'utf8')).shows;
  const ret = JSON.parse(fs.readFileSync(path.join(D, 'retired-show-ids.json'), 'utf8'));
  const slugs = new Set(live.map((s) => s.slug));
  const existing = {};
  const derived = deriveRetiredIdRedirects(ret, live, slugs);
  for (const e of ret) {
    const m = /\bduplicate of ([a-z0-9-]+)/i.exec(e.reason || '');
    if (!m || !live.some((s) => s.id === m[1]) || live.some((s) => s.id === e.id)) continue;
    assert.ok(derived[e.id] || existing[e.id], `${e.id} must resolve`);
  }
});
