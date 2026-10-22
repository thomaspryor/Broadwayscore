/**
 * BRO-5399: Search Console reported "Duplicate, Google chose different canonical
 * than user" and "Soft 404". Root cause of the first: src/app/layout.tsx sets
 * alternates.canonical = the homepage, and Next inherits it into any page whose
 * own metadata omits `alternates`. /award-score/[season] (57 sitemap URLs) told
 * Google every season page was a copy of the homepage.
 *
 * Guard: every public page must export metadata that declares its own canonical.
 * Routes that are private or only redirect are listed in NOT_INDEXED / REDIRECT_ONLY
 * with the reason. (Comparison slugs are covered by comparison-slugs-resolve.test.ts.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isThinActorProfile } = require('../../scripts/lib/actor-indexability.js');

const APP_DIR = path.join(process.cwd(), 'src', 'app');

// Route prefixes that are private, auth flows, fixtures or token pages: never indexed
// (/nvp is noindex via src/app/nvp/layout.tsx).
const NOT_INDEXED = [
  '/admin', '/auth', '/test', '/dev', '/studio', '/plans', '/seen', '/my-shows',
  '/diary-show', '/nvp', '/fantasy/league',
];

// Public routes that only redirect (server redirect() or a client-side refresh to
// the real page, with the primary redirect in vercel.json). Nothing to canonicalize.
const REDIRECT_ONLY = ['/how-broadway-scores-work', '/gold', '/biz-buzz'];

function pageFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageFiles(full));
    else if (entry.name === 'page.tsx' || entry.name === 'page.ts') out.push(full);
  }
  return out;
}

function routeOf(file) {
  const rel = path.relative(APP_DIR, path.dirname(file)).split(path.sep).join('/');
  return '/' + rel;
}

test('every indexable page declares its own canonical in exported metadata', () => {
  const offenders = [];
  for (const file of pageFiles(APP_DIR)) {
    const route = routeOf(file);
    if (NOT_INDEXED.some((p) => route === p || route.startsWith(p + '/'))) continue;
    if (REDIRECT_ONLY.includes(route)) continue;
    // Client-component pages keep their metadata in the sibling layout.tsx.
    const layout = path.join(path.dirname(file), 'layout.tsx');
    const src = fs.readFileSync(file, 'utf8') + (fs.existsSync(layout) ? '\n' + fs.readFileSync(layout, 'utf8') : '');
    const exportsMetadata = /export\s+(async\s+)?function\s+generateMetadata|export\s+const\s+metadata\b/.test(src);
    // A page with no metadata export inherits the root layout's homepage canonical.
    const declaresCanonical = /alternates\s*:|canonical\s*:|marketAlternates\(/.test(src);
    if (!exportsMetadata || !declaresCanonical) offenders.push(route);
  }
  assert.deepEqual(
    offenders,
    [],
    `These pages have no own canonical and inherit the homepage canonical from the root layout: ${offenders.join(', ')}. Add alternates.canonical, or list the route in NOT_INDEXED / REDIRECT_ONLY with a reason.`
  );
});

test('thin actor pages (one credit, no score) are not indexable', () => {
  assert.equal(isThinActorProfile({ showCount: 1, scoredShowCount: 0, avgScore: null }), true);
  assert.equal(isThinActorProfile({ showCount: 0, scoredShowCount: 0, avgScore: null }), true);
  assert.equal(isThinActorProfile(undefined), true);
});

test('a thin actor with Tony nominations stays indexable', () => {
  const thin = { showCount: 1, scoredShowCount: 0, avgScore: null };
  assert.equal(isThinActorProfile(thin, 0), true);
  assert.equal(isThinActorProfile(thin, 2), false);
});

test('actor pages with a score or more than one credit stay indexable', () => {
  // creatives keep the legacy rule; /cast uses singleCreditIsThin (BRO-5969)
  assert.equal(isThinActorProfile({ showCount: 1, scoredShowCount: 1, avgScore: 64 }), false);
  assert.equal(isThinActorProfile({ showCount: 1, scoredShowCount: 1, avgScore: 64 }, 0, false, true), true);
  assert.equal(isThinActorProfile({ showCount: 2, scoredShowCount: 0, avgScore: null }), false);
  assert.equal(isThinActorProfile({ showCount: 4, scoredShowCount: 4, avgScore: 68 }), false);
});

test('page robots and sitemap share one indexability decision for cast and creative', () => {
  const read = (...p) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
  const sitemap = read('src', 'app', 'sitemap.ts');
  const castPage = read('src', 'app', 'cast', '[slug]', 'page.tsx');
  const creativePage = read('src', 'app', 'creative', '[slug]', 'page.tsx');
  assert.match(sitemap, /isThinActor\(/);
  assert.match(castPage, /isThinActor\(/);
  assert.match(sitemap, /isThinCreative\(/);
  assert.match(creativePage, /isThinCreative\(/);
  // The raw rule must not be re-implemented per call site: a page that is noindex
  // but still in the sitemap (or the reverse) is what Search Console flags.
  for (const src of [sitemap, castPage, creativePage]) assert.doesNotMatch(src, /isThinActorProfile\(/);
});
