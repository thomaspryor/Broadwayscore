/**
 * Guards the exposure argument behind the GHSA-2xp9-vwfh-vxw4 allowlist entry
 * in scripts/audit-dependencies.js (BRO-3202).
 *
 * That advisory is an unauthenticated RCE triggered when Next.js's image
 * optimizer DECODES an AVIF, and /_next/image is a public endpoint that is live
 * on prod. The entry claims the advisory can't reach us. Two of the three legs
 * of that claim were prose in a comment, which ages badly and silently:
 *
 *   1. "remote image input is scoped to our own Contentful space" — true only
 *      while nobody re-adds a host-only entry for a MULTI-TENANT CDN.
 *      res.cloudinary.com/<anyone's-cloud>/ and any bucket under
 *      **.amazonaws.com are attacker-controllable, so a host-only entry for
 *      either hands an anonymous caller a way to feed the optimizer whatever
 *      bytes they like. Verified live on 2026-09-13: an AVIF under
 *      res.cloudinary.com/demo/ returned 200 through prod /_next/image.
 *   2. "same-origin /images/** holds zero .avif files" — true only until
 *      someone adds one.
 *
 * The third leg (Vercel currently passes AVIF through unoptimized) is a
 * PLATFORM behaviour we don't control and deliberately isn't asserted here — it
 * corroborates the argument, it doesn't carry it. These two tests are the legs
 * we own, so they're the ones that must fail loudly when they stop being true.
 *
 * If a test here fails, do not just edit the test: re-read that allowlist entry
 * and decide whether the exemption still holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);

/** Hosts that serve many customers from one domain, so the path segment is the
 * only thing separating our content from an attacker's. */
const MULTI_TENANT_HOSTS = [
  'res.cloudinary.com',
  'amazonaws.com',
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
  'images.ctfassets.net',
  'cdn.sanity.io',
  'raw.githubusercontent.com',
  'githubusercontent.com',
  's3.amazonaws.com',
];

const isMultiTenant = (hostname) =>
  MULTI_TENANT_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`) || hostname.endsWith(h));

test('every remotePatterns entry for a multi-tenant CDN is scoped by pathname', () => {
  const config = require(path.join(ROOT, 'next.config.js'));
  const patterns = (config.images && config.images.remotePatterns) || [];

  for (const p of patterns) {
    const hostname = String(p.hostname || '');
    if (!isMultiTenant(hostname)) continue;

    const pathname = String(p.pathname || '');
    assert.ok(
      pathname && pathname !== '/**' && pathname !== '**',
      `next.config.js images.remotePatterns allows "${hostname}" with no pathname restriction. `
      + 'That host serves many customers from one domain, so this lets any anonymous caller push '
      + 'arbitrary bytes — including the AVIF behind GHSA-2xp9-vwfh-vxw4 — through the public '
      + '/_next/image endpoint. Scope it to our own account/space/bucket prefix.',
    );
    assert.ok(
      pathname.split('/').filter(Boolean).some((seg) => !seg.includes('*')),
      `next.config.js images.remotePatterns scopes "${hostname}" to "${pathname}", which is all `
      + 'wildcards and therefore no restriction at all. At least one literal path segment '
      + '(the account id, space id or bucket name) is required.',
    );
  }
});

test('no AVIF files are served from public/ (the optimizer must never be handed one from our own origin)', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (/\.avif$/i.test(entry.name)) found.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'public'));

  assert.deepEqual(
    found, [],
    'AVIF files under public/ can be fed to /_next/image from our own origin, which is the decode '
    + 'path behind GHSA-2xp9-vwfh-vxw4. Convert them to WebP/JPEG, or re-triage that allowlist '
    + 'entry in scripts/audit-dependencies.js.',
  );
});

test('/_next/image has exactly one consumer in src/, and it is the OG route', () => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      // The import form (next/image) and the raw endpoint are both consumers.
      if (/_next\/image/.test(src) || /from\s+['"]next\/image['"]/.test(src)) {
        hits.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src'));

  assert.deepEqual(
    hits.sort(), ['src/app/show/[slug]/opengraph-image.tsx'],
    'A new consumer of the Next image optimizer changes the exposure assessment for '
    + 'GHSA-2xp9-vwfh-vxw4: today the only caller passes same-origin /images/** paths, which is '
    + 'why the remotePatterns scoping above is sufficient. If a component now renders '
    + 'attacker-influenced or third-party image URLs through it, re-read that allowlist entry in '
    + 'scripts/audit-dependencies.js before updating this list.',
  );
});
