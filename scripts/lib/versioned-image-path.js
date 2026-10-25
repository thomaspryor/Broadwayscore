'use strict';
/**
 * Content-versioned image paths for the mobile feeds (BRO-5734).
 *
 * /images/* is served `Cache-Control: public, max-age=31536000, immutable`
 * (vercel.json) and the iOS app's expo-image keeps files on disk by URL. A
 * show's art is replaced in place (same /images/shows/<id>/poster.jpg), so a
 * phone that once loaded the wrong art (the Prime Video "KEVIN" series poster
 * for the SoHo Playhouse parody "KEVIN!!!!!") kept showing it after the file
 * was fixed. Appending ?v=<first 8 hex of the file's md5> makes the URL change
 * exactly when the bytes change; static hosting ignores the query.
 *
 * Pure apart from reading the named file. Paths that are not local /images/
 * paths, already carry a query, or whose file is missing come back unchanged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const cache = new Map();

function versionedImagePath(p, publicDir = PUBLIC_DIR) {
  if (typeof p !== 'string' || !p.startsWith('/images/') || p.includes('?') || p.includes('..')) return p;
  const file = path.join(publicDir, p);
  let stat;
  try { stat = fs.statSync(file); } catch { return p; }
  if (!stat.isFile()) return p;
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  let v = cache.get(key);
  if (!v) {
    v = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
    cache.set(key, v);
  }
  return `${p}?v=${v}`;
}

module.exports = { versionedImagePath };
