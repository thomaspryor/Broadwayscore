'use strict';
/**
 * BRO-5739: a data-edit that nulls a show's images in shows.json does nothing
 * while the files are still in public/images/shows/<id>/. pre-deploy-check.js
 * ("Orphan image auto-fix") re-attaches any file on disk to a null image field
 * on every deploy, so the wrong art came straight back. The plan must land
 * with the files removed (git rm) in the same land branch.
 *
 * Pure apart from fs.existsSync. Returns the repo-relative files that would be
 * re-attached for one plan action ([] when the action is not an images null-out).
 */
const fs = require('fs');
const path = require('path');

const FORMATS = ['thumbnail', 'poster', 'hero'];
const EXTS = ['webp', 'jpg', 'png'];

function orphanFilesAfterNulling(action, publicDir = path.join(__dirname, '..', '..', 'public')) {
  if (!action || action.type !== 'data-edit' || action.file !== 'shows.json' || action.field !== 'images') return [];
  const newV = action.newValue || {};
  const id = action.showId;
  if (!id || !/^[a-z0-9-]+$/.test(id)) return [];
  const out = [];
  for (const f of FORMATS) {
    if (newV[f]) continue; // pre-deploy-check fills EVERY null field from disk, whatever the old value was
    for (const ext of EXTS) {
      const rel = `public/images/shows/${id}/${f}.${ext}`;
      if (fs.existsSync(path.join(publicDir, '..', rel))) out.push(rel);
    }
  }
  return out;
}

module.exports = { orphanFilesAfterNulling };
