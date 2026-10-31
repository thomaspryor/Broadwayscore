'use strict';

/**
 * First Load JS per route from the prerendered HTML (BRO-6609).
 *
 * Next 16 dropped the per-route size table from `next build`, so
 * bundle-size-parse.js finds nothing. The prerendered page lists the script
 * chunks the browser loads first; their gzip sum is the route's First Load JS
 * (gzip kB, as the old table printed). prerender-manifest.json maps each
 * prerendered path to its source route, so one sample page stands in for a
 * dynamic route such as /show/[slug].
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SCRIPT_RE = /<script[^>]*\ssrc="\/_next\/(static\/[^"?]+\.js)"/g;

function htmlFor(nextDir, urlPath) {
  const rel = urlPath === '/' ? 'index' : urlPath.replace(/^\//, '');
  const f = path.join(nextDir, 'server', 'app', `${rel}.html`);
  return fs.existsSync(f) ? f : null;
}

function parseBuildManifests(nextDir) {
  const gz = new Map();
  const bytes = (rel) => {
    if (!gz.has(rel)) {
      let n = 0;
      try { n = zlib.gzipSync(fs.readFileSync(path.join(nextDir, rel))).length; } catch { /* chunk not on disk */ }
      gz.set(rel, n);
    }
    return gz.get(rel);
  };
  const prerender = JSON.parse(fs.readFileSync(path.join(nextDir, 'prerender-manifest.json'), 'utf8'));
  const pages = {};
  let sharedJS = null;
  for (const [urlPath, info] of Object.entries(prerender.routes || {})) {
    const route = (info && info.srcRoute) || urlPath;
    if (pages[route] != null) continue;
    const f = htmlFor(nextDir, urlPath);
    if (!f) continue;
    const scripts = new Set([...fs.readFileSync(f, 'utf8').matchAll(SCRIPT_RE)].map((m) => m[1]));
    if (!scripts.size) continue;
    let total = 0;
    for (const s of scripts) total += bytes(s);
    pages[route] = Math.round((total / 1024) * 10) / 10;
  }
  // Shared JS = the scripts every sampled page loads.
  const sets = Object.keys(pages).length;
  if (sets) {
    const counts = new Map();
    for (const [urlPath, info] of Object.entries(prerender.routes || {})) {
      const route = (info && info.srcRoute) || urlPath;
      const f = htmlFor(nextDir, urlPath);
      if (!f || counts.has(route)) continue;
      counts.set(route, new Set([...fs.readFileSync(f, 'utf8').matchAll(SCRIPT_RE)].map((m) => m[1])));
    }
    const all = [...counts.values()];
    const common = [...all[0]].filter((s) => all.every((x) => x.has(s)));
    sharedJS = Math.round((common.reduce((n, s) => n + bytes(s), 0) / 1024) * 10) / 10;
  }
  return { pages, sharedJS };
}

module.exports = { parseBuildManifests };
