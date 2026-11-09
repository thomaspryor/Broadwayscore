const fs = require('fs');
const path = require('path');
const { matchRemotePattern } = require('next/dist/shared/lib/match-remote-pattern');
const IMAGE_POINTER_BASELINE = require('./image-pointer-baseline.json');

/**
 * BRO-3204: existing missing files warn so unrelated data pushes can proceed.
 * Remove entries from image-pointer-baseline.json as their files/pointers are
 * repaired. Match the exact pointer and failure, so a baselined show cannot
 * acquire another broken image without failing validation.
 */
function imagePointerSeverity(problem) {
  return IMAGE_POINTER_BASELINE.some(entry =>
    entry.id === problem.id && entry.key === problem.key &&
    entry.value === problem.value && entry.reason === problem.reason
  ) ? 'warn' : 'error';
}

/**
 * BRO-7097: the Codex runner checks out slim worktrees (sparse-checkout, no public/images/shows),
 * where every local image looks missing. A missing file proves nothing there, so the finders
 * below report no problems rather than nulling or failing every show.
 */
// The public/images dirs a slim worktree leaves out (mirror of SLIM_EXCLUDED_DIRS in codex-runner.js).
const SLIM_IMAGE_PREFIXES = ['/images/shows/', '/images/video-reviews/'];
const inSlimExcluded = (pathname) => SLIM_IMAGE_PREFIXES.some((p) => pathname.startsWith(p));
function isSparseTree(publicDir) {
  try {
    const r = require('child_process').spawnSync('git', ['-C', fs.existsSync(publicDir) ? publicDir : path.dirname(publicDir), 'config', '--get', 'core.sparseCheckout'], { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch { return false; }
}

/** Validate stored hero/poster pointers without fetching or changing any data. */
function findImagePointerProblems(shows, { publicDir, remotePatterns = [] }) {
  const imagesDir = path.resolve(publicDir, 'images');
  const problems = [];
  const sparse = isSparseTree(publicDir);
  for (const show of shows) {
    for (const key of ['hero', 'poster']) {
      const value = show.images?.[key];
      if (value == null) continue;
      let reason;
      try {
        if (typeof value !== 'string' || !value.trim()) {
          reason = 'expected a non-empty image path or URL';
        } else if (value.startsWith('/') && !value.startsWith('//')) {
          const pathname = decodeURIComponent(value.split(/[?#]/)[0]);
          const file = path.resolve(publicDir, `.${pathname}`);
          const relative = path.relative(imagesDir, file);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            reason = 'local image must be under public/images/';
          } else if (!(sparse && inSlimExcluded(pathname)) && (!fs.existsSync(file) || !fs.statSync(file).isFile())) {
            reason = 'local image file does not exist';
          }
        } else {
          const url = new URL(value);
          if (!['https:', 'http:'].includes(url.protocol) || !remotePatterns.some(p => matchRemotePattern(p, url))) {
            reason = 'remote image is not allowed by next.config.js images.remotePatterns';
          }
        }
      } catch {
        reason = 'invalid or unreadable image pointer';
      }
      if (reason) problems.push({ id: show.id, key, value, reason });
    }
  }
  return problems;
}

/**
 * BRO-6221: local /images/ pointers (thumbnail, poster, hero) whose file is not
 * in public/. Each one is a 404 on prod; nulling it shows the placeholder and
 * lets fetch-show-images refill the slot. Pure apart from existence checks.
 * Returns [{ id, key, value }] in show order.
 */
const DANGLING_IMAGE_KEYS = ['thumbnail', 'poster', 'hero'];
function findDanglingLocalImageRefs(shows, { publicDir, keys = DANGLING_IMAGE_KEYS } = {}) {
  const out = [];
  const sparse = isSparseTree(publicDir);
  for (const show of shows || []) {
    for (const key of keys) {
      const value = show && show.images && show.images[key];
      if (typeof value !== 'string' || !value.startsWith('/images/')) continue;
      let pathname;
      try { pathname = decodeURIComponent(value.split(/[?#]/)[0]); } catch { pathname = null; }
      if (sparse && pathname && inSlimExcluded(pathname)) continue; // not checked out in a slim tree: proves nothing
      const file = pathname && path.resolve(publicDir, `.${pathname}`);
      let present = false;
      try { present = Boolean(file) && fs.statSync(file).isFile(); } catch { present = false; }
      if (!present) out.push({ id: show.id, key, value });
    }
  }
  return out;
}

/** One whole-object `images` data-edit per show, nulling only the dangling keys. Pure. */
function danglingImageNullingActions(shows, dangling) {
  const byId = new Map();
  for (const d of dangling) {
    if (!byId.has(d.id)) byId.set(d.id, []);
    byId.get(d.id).push(d.key);
  }
  const actions = [];
  for (const show of shows) {
    const keys = byId.get(show.id);
    if (!keys) continue;
    const newValue = { ...show.images };
    for (const k of keys) newValue[k] = null;
    actions.push({
      type: 'data-edit', file: 'shows.json', showId: show.id, field: 'images',
      oldValue: show.images, newValue,
      description: `shows.json: ${show.id}.images ${keys.join('+')} -> null (file missing from public/, BRO-6221)`,
    });
  }
  return actions;
}

module.exports = {
  findImagePointerProblems, imagePointerSeverity, isSparseTree,
  findDanglingLocalImageRefs, danglingImageNullingActions, DANGLING_IMAGE_KEYS,
};
