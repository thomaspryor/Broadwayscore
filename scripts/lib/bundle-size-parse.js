'use strict';
/**
 * Parse `next build`'s route table into First Load JS sizes (kB).
 *
 * Rows look like `├ ○ /path   1.23 kB   94.5 kB`. The first row of the table
 * starts with ┌, and a route with almost no own code prints its size in
 * bytes (`├ ● /show/[slug]   168 B   289 kB   1d   1y`). The old inline regex
 * matched only ├/└ rows with a kB first column, so the homepage and every
 * show page were never checked (BRO-5985).
 */

const UNIT_TO_KB = { B: 1 / 1024, kB: 1, MB: 1024 };
const SIZE = '([\\d.]+)\\s+(B|kB|MB)';
const PAGE_ROW_RE = new RegExp(`[┌├└]\\s+[○●ƒ◐λ]\\s+(\\S+)\\s+${SIZE}\\s+${SIZE}`);
const ROUTE_HANDLER_RE = /^\/api\/|\.[a-z0-9]+$|\/(opengraph-image|twitter-image|icon|apple-icon)(\/|$)/i;
const SHARED_RE = new RegExp(`First Load JS shared by all\\s+${SIZE}`);

function toKb(value, unit) {
  return Math.round(parseFloat(value) * UNIT_TO_KB[unit] * 10) / 10;
}

function parseBuildOutput(output) {
  const pages = {};
  let sharedJS = null;
  for (const line of String(output).split('\n')) {
    const page = line.match(PAGE_ROW_RE);
    // Route handlers (API, feeds, OG images) print as tiny rows that carry
    // only the shared JS; leave them out so the page count and the
    // "heaviest pages" list stay pages.
    if (page && !ROUTE_HANDLER_RE.test(page[1])) pages[page[1]] = toKb(page[4], page[5]);
    const shared = line.match(SHARED_RE);
    if (shared) sharedJS = toKb(shared[1], shared[2]);
  }
  return { pages, sharedJS };
}

module.exports = { parseBuildOutput };
