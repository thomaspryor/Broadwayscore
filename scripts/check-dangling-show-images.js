#!/usr/bin/env node
'use strict';
/**
 * check-dangling-show-images.js (BRO-6221): list shows.json images.thumbnail /
 * poster / hero values that are local /images/ paths with no file in public/.
 * Each one is a 404 on prod (272 thumbnail/poster refs on 215 closed shows when
 * this was written). A null slot renders the placeholder instead, and the
 * Mon/Thu fetch-show-images run refills it when art is found.
 *
 * Usage:
 *   node scripts/check-dangling-show-images.js                 # list; exit 0 only when none
 *   node scripts/check-dangling-show-images.js --json          # machine-readable list
 *   node scripts/check-dangling-show-images.js --shows=PATH    # another shows.json copy
 *   node scripts/check-dangling-show-images.js --plan-actions=OUT.json
 *       write one `images` data-edit per affected show (dangling keys set to null,
 *       other keys untouched) for `node scripts/new-fix-plan.js --actions=OUT.json`
 *
 * Exit: 0 = no dangling refs, 1 = dangling refs found, 2 = could not run.
 */
const fs = require('fs');
const path = require('path');
const { findDanglingLocalImageRefs, danglingImageNullingActions } = require('./lib/image-pointers');

const ROOT = path.join(__dirname, '..');

function main(argv) {
  const get = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const showsPath = path.resolve(get('shows') || path.join(ROOT, 'data', 'shows.json'));
  let shows;
  try {
    const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    shows = raw.shows || raw;
    if (!Array.isArray(shows)) throw new Error('no shows array');
  } catch (e) {
    console.error(`could not read ${showsPath}: ${e.message}`);
    return 2;
  }
  const dangling = findDanglingLocalImageRefs(shows, { publicDir: path.join(ROOT, 'public') });
  const outPath = get('plan-actions');
  if (outPath) {
    const actions = danglingImageNullingActions(shows, dangling);
    fs.writeFileSync(outPath, JSON.stringify(actions, null, 2) + '\n');
    console.error(`wrote ${actions.length} images data-edits to ${outPath}`);
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ showsPath, count: dangling.length, dangling }, null, 2));
  } else {
    for (const d of dangling) console.log(`${d.id} images.${d.key}: ${d.value}`);
    const showCount = new Set(dangling.map((d) => d.id)).size;
    console.log(dangling.length
      ? `${dangling.length} dangling local image refs on ${showCount} shows (${showsPath})`
      : `OK: no dangling local image refs (${showsPath})`);
  }
  return dangling.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
