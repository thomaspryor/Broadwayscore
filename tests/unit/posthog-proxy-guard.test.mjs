import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BRO-5984: browser code must reach PostHog through the same-origin /ingest
// proxy (src/lib/posthog-proxy.ts). A hard-coded PostHog host is ad-blocked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no src file hard-codes a PostHog ingestion host', () => {
  const offenders = walk(root)
    .filter((f) => !f.endsWith(path.join('lib', 'posthog-proxy.ts')))
    .filter((f) => /https?:\/\/(us|eu)(-assets)?\.i\.posthog\.com/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});

test('vercel.json proxies /ingest to PostHog (static assets first)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, '..', 'vercel.json'), 'utf8'));
  const r = v.rewrites.map((x) => x.source);
  assert.ok(r.indexOf('/ingest/static/:path*') !== -1 && r.indexOf('/ingest/static/:path*') < r.indexOf('/ingest/:path*'));
});
