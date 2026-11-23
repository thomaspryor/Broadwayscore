'use strict';
/**
 * BRO-8155: drop the redundant file copy of data/reviews.json (~46MB) from every
 * function trace that does not read it with fs at runtime.
 *
 * Why it is redundant: pages import it statically (`import reviewsData from
 * '../../data/reviews.json'` in data-core / data-reviews / data-review-arrival),
 * so webpack inlines the content into the server chunk (~36MB there). Next also
 * adds each bundled JSON's SOURCE file to the route's .nft.json, so every
 * data-backed function carried the data twice and Vercel packed fewer routes
 * per function (4 functions at 204-217MB of the 250MB limit, 2026-11-23).
 *
 * Only a route that reads the file with fs at runtime needs it on disk. Those
 * are listed in REVIEWS_JSON_FS_READERS and keep it. scripts/lib/
 * check-trace-runtime-reads.js verifies after a build that no route's compiled
 * code names the file without having it traced.
 *
 * Next matches outputFileTracingExcludes keys against the route with picomatch
 * `{ dot: true, contains: true }`: a SUBSTRING match, and `^`/`$` are literal, so a
 * route's key also hits every longer route that contains it. A key that would hit
 * a reader is therefore dropped (that route keeps the file; today `/` and
 * `/admin`), never anchored. Keys are the escaped route string.
 */

const fs = require('fs');
const path = require('path');
const picomatch = require('next/dist/compiled/picomatch');

/** The matcher options Next's collect-build-traces.js uses for these keys. */
const NEXT_MATCH_OPTS = { dot: true, contains: true };

/**
 * Files webpack inlines (static import) and that no compiled code reads by path:
 * their on-disk copy is dead weight in a function. reviews.json ~46MB,
 * grosses-history.json ~7MB, cast-manifest.json ~5MB. A file is only safe here
 * if check-trace-runtime-reads.js finds no fs read of it in any route.
 */
const REDUNDANT_INLINED_JSON = ['data/reviews.json', 'data/grosses-history.json', 'data/cast-manifest.json'];

/**
 * Vercel packs routes with equal function options (maxDuration, memory, regions)
 * into one function up to the size limit. The reader routes declare this
 * maxDuration, which no other route uses, so their group is theirs alone and
 * the 46MB file no longer rides in a group of unrelated routes.
 */
const READER_MAX_DURATION = 60;

/** Routes (as Next names them) whose compiled code reads data/reviews.json with fs. */
const REVIEWS_JSON_FS_READERS = [
  '/api/health/drift',
  '/api/admin/ingest-review',
  '/api/admin/ingest-review/detect',
  '/api/admin/lock-score',
];

const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;
const METADATA_FILE = /^(sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(tsx|ts|js)$/;

function escapeGlob(s) {
  return s.replace(/[\\[\](){}!*?+@|^$]/g, '\\$&');
}

/** Every app-router route under appDir, named the way Next names an entry. */
function listAppRoutes(appDir) {
  const routes = new Set();
  (function walk(dir, segs) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name.startsWith('_') || e.name.startsWith('@')) continue;
        const isGroup = /^\(.*\)$/.test(e.name);
        walk(path.join(dir, e.name), isGroup ? segs : [...segs, e.name]);
      } else if (ROUTE_FILE.test(e.name)) {
        routes.add('/' + segs.join('/'));
      } else if (METADATA_FILE.test(e.name)) {
        routes.add('/' + [...segs, e.name.replace(/\.[^.]+$/, '')].join('/'));
      }
    }
  })(appDir, []);
  return [...routes].sort();
}

/**
 * @param {{ appDir: string, readers?: string[], files?: string[] }} opts
 * @returns {Record<string, string[]>} outputFileTracingExcludes entries
 */
function redundantInlinedJsonExcludes({ appDir, readers = REVIEWS_JSON_FS_READERS, files = REDUNDANT_INLINED_JSON }) {
  const keep = new Set(readers);
  const hitsReader = (key) => readers.some((r) => picomatch(key, NEXT_MATCH_OPTS)(r));
  const out = {};
  for (const route of listAppRoutes(appDir)) {
    if (keep.has(route)) continue;
    const key = route.split('/').map(escapeGlob).join('/');
    if (hitsReader(key)) continue; // substring of a reader's route: keep the file here
    out[key] = files;
  }
  return out;
}

module.exports = { READER_MAX_DURATION, REDUNDANT_INLINED_JSON, NEXT_MATCH_OPTS, REVIEWS_JSON_FS_READERS, listAppRoutes, redundantInlinedJsonExcludes, escapeGlob };
