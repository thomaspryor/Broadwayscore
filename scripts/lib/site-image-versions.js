'use strict';

// Build a small manifest instead of tracing public/images into server functions.
const fs = require('fs');
const path = require('path');
const { versionedImagePath } = require('./versioned-image-path');

function buildSiteImageVersions(publicDir) {
  const versions = {};
  function visit(relativeDir) {
    const dir = path.join(publicDir, relativeDir);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) {
        const imagePath = `/${relative}`;
        versions[imagePath] = versionedImagePath(imagePath, publicDir);
      }
    }
  }
  visit('images');
  return versions;
}

function writeSiteImageVersions() {
  const root = path.join(__dirname, '..', '..');
  const versions = buildSiteImageVersions(path.join(root, 'public'));
  const file = path.join(root, 'data', 'site-image-versions.json');
  const json = JSON.stringify(versions);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== json) {
    // Atomic: the show-refresh manifest builder and next.config.js both write
    // it, and a reader must never see a half-written file (BRO-8056).
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  }
  return versions;
}

module.exports = { buildSiteImageVersions, writeSiteImageVersions };
