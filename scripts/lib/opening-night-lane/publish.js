'use strict';
/**
 * Opening-night lane publish path (BRO-4785, epic BRO-4210 phase 3; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6).
 *
 * After scoring: merge the show's rows into reviews.json BY KEY, regenerate only this show's public JSON, ship an
 * explicit deploy, then poll the cache-busted live JSON until each review's URL is there. Each step logs its ledger
 * event (rebuilt, deployed, verified-live), so time-to-live is measured from what a reader could actually see.
 *
 * Everything that touches the outside world is a PORT passed in (reviews file, data push, regenerate, deploy, live
 * fetch). That keeps the orchestration testable with a local static server (the rehearsal) and lets CI inject the
 * real ones. Nothing here deploys or pushes on its own.
 *
 * Merge-by-key, never a whole-file rewrite from a stale snapshot: the reviews port re-reads the file right before it
 * writes and retries if the bytes changed in between, so a concurrent writer's rows for other shows survive.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ledger = require('./ledger');
const { canonicalUrl } = require('./discovery');
const { keyOf, urlKeyOf, resolveConflict } = require('../merge-reviews-json');

const DEFAULT_POLL_MS = 15 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // matches the ledger's first acceptance bar

/**
 * Merge incoming rows for ONE show into a reviews.json document. Pure. Rows of every other show are returned
 * untouched (same objects, same order). A same-identity row is resolved with the shared merge rules (a manual
 * correction beats a pipeline row; otherwise the richer content tier wins; a tie takes the incoming row).
 * @returns {{doc, added, replaced, kept}}
 */
function mergeShowRows(doc, showId, incoming) {
  if (!showId) throw new Error('publish: showId is required');
  const base = doc && typeof doc === 'object' ? doc : {};
  const reviews = Array.isArray(base.reviews) ? base.reviews.slice() : [];
  let added = 0; let replaced = 0; let kept = 0;
  const byPrimary = new Map();
  const byUrl = new Map();
  reviews.forEach((r, i) => {
    if (!r || r.showId !== showId) return;
    const k = keyOf(r); if (k && !byPrimary.has(k)) byPrimary.set(k, i);
    const u = urlKeyOf(r); if (u && !byUrl.has(u)) byUrl.set(u, i);
  });
  for (const row of incoming || []) {
    if (!row || row.showId !== showId) throw new Error(`publish: row for "${row && row.showId}" in a "${showId}" publish`);
    const k = keyOf(row); const u = urlKeyOf(row);
    const at = byPrimary.has(k) ? byPrimary.get(k) : (u && byUrl.has(u) ? byUrl.get(u) : -1);
    if (at < 0) {
      reviews.push(row); added++;
      const i = reviews.length - 1;
      if (k) byPrimary.set(k, i); if (u) byUrl.set(u, i);
    } else if (resolveConflict(reviews[at], row) === 'remote') {
      reviews[at] = row; replaced++;
    } else kept++;
  }
  return { doc: { ...base, reviews }, added, replaced, kept };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Reviews port over a file: read, apply fn(doc), re-check the bytes, write atomically. If another writer changed the
 * file between our read and our write, start over from the fresh bytes instead of overwriting them.
 * `beforeWrite` is a test seam for simulating that concurrent writer.
 */
function createReviewsFilePort(file, { attempts = 5, beforeWrite = null } = {}) {
  return {
    async updateReviews(fn) {
      for (let i = 0; i < attempts; i++) {
        const raw = fs.readFileSync(file);
        const out = fn(JSON.parse(raw.toString('utf8')));
        if (beforeWrite) beforeWrite(i);
        if (sha(fs.readFileSync(file)) !== sha(raw)) continue; // someone else wrote: redo on top of their version
        const tmp = `${file}.lane-${process.pid}-${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(out.doc)}\n`);
        fs.renameSync(tmp, file);
        return out;
      }
      throw new Error(`publish: ${file} kept changing under us (${attempts} attempts); nothing was written`);
    },
  };
}

/**
 * @param {object} args
 *   show, night, rows [{key, row}] (key = the discovery canonical URL; row = the reviews.json record),
 *   ledgerDir, ports {updateReviews(fn), pushData?(), regenShow(showId), deploy(), fetchLiveShow(showId)},
 *   now?(), sleep?(ms), pollMs, timeoutMs
 * @returns {{merge, verified, missing, timedOut, ms}}
 */
async function publishLaneReviews({ show, night, rows, ledgerDir, ports, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!show || !night || !ledgerDir || !ports) throw new Error('publish: show, night, ledgerDir and ports are required');
  if (!Array.isArray(rows) || !rows.length) return { merge: { added: 0, replaced: 0, kept: 0 }, verified: [], missing: [], timedOut: false, ms: 0 };
  for (const p of ['updateReviews', 'regenShow', 'deploy', 'fetchLiveShow']) if (typeof ports[p] !== 'function') throw new Error(`publish: port "${p}" is required`);
  const t0 = now();
  const log = (key, stage, meta) => ledger.appendEvent(ledgerDir, { show, night, reviewKey: key, stage, at: now(), ...(meta ? { meta } : {}) });

  const merge = await ports.updateReviews((doc) => mergeShowRows(doc, show, rows.map((r) => r.row)));
  if (ports.pushData) {
    const pushed = await ports.pushData();
    if (pushed && pushed.ok === false) throw new Error(`publish: pushing core data failed: ${String(pushed.stderr || '').slice(0, 200)}`);
  }
  await ports.regenShow(show);
  for (const r of rows) log(r.key, 'rebuilt');
  await ports.deploy();
  for (const r of rows) log(r.key, 'deployed');

  const pending = new Map(rows.map((r) => [canonicalUrl(r.row.url) || r.key, r.key]));
  const verified = [];
  let timedOut = false;
  for (;;) {
    let live = null;
    try { live = await ports.fetchLiveShow(show); } catch { live = null; } // a failed poll is a missed poll, not a failure
    const liveUrls = new Set(((live && live.rv) || []).map((x) => canonicalUrl(x && x.u)).filter(Boolean));
    for (const [url, key] of [...pending]) {
      if (!liveUrls.has(url)) continue;
      log(key, 'verified-live'); verified.push(key); pending.delete(url);
    }
    if (!pending.size) break;
    if (now() - t0 >= timeoutMs) { timedOut = true; break; }
    await sleep(pollMs);
  }
  return { merge: { added: merge.added, replaced: merge.replaced, kept: merge.kept }, verified, missing: [...pending.values()], timedOut, ms: now() - t0 };
}

// ---- real-world ports (thin; CI wires the deploy) -----------------------------------------------------------------

/** Regenerate only this show's public JSON (the generator's scoped mode leaves the shared hash cache alone). */
function regenShowViaScript({ cwd = process.cwd() } = {}) {
  return (showId) => execFileSync('node', ['scripts/generate-mobile-show-details.js', `--show=${showId}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Live fetch with a cache-busting query and no-cache headers, so a CDN copy cannot make a review look live early. */
function fetchLiveShowFrom(baseUrl, { fetchImpl = globalThis.fetch } = {}) {
  return async (showId) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/data/shows/${encodeURIComponent(showId)}.json?cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`live fetch ${showId}: HTTP ${res.status}`);
    return res.json();
  };
}

/** Rehearsal server: serves a directory over HTTP on a free local port. */
function startStaticServer(dir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

/** Dry-run deploy: "ships" the show's public JSON by copying it into the directory the static server serves. */
function dryRunDeploy({ publicDir, liveDir, showId, delayMs = 0 }) {
  return async () => {
    const copy = () => {
      fs.mkdirSync(path.join(liveDir, 'data', 'shows'), { recursive: true });
      fs.copyFileSync(path.join(publicDir, 'data', 'shows', `${showId}.json`), path.join(liveDir, 'data', 'shows', `${showId}.json`));
    };
    if (delayMs > 0) setTimeout(copy, delayMs); else copy(); // a delay models the CDN lag the poll exists for
  };
}

module.exports = {
  DEFAULT_POLL_MS, DEFAULT_TIMEOUT_MS, mergeShowRows, createReviewsFilePort, publishLaneReviews,
  regenShowViaScript, fetchLiveShowFrom, startStaticServer, dryRunDeploy,
};
