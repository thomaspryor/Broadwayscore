'use strict';
// shows-json-fixture.js (BRO-8107) — TEST helper for shows-json-path.js. Kept
// apart because it writes files: production readers require shows-json-path.js,
// and a write in that graph breaks safe-form audit scripts' write-free check.
const path = require('path');
const fs = require('fs');

/**
 * Test helper: write `shows` to a temp shows.json and point SHOWS_JSON_PATH at
 * it (in this process and every process it spawns). Returns a restore function
 * that puts the previous value back and deletes the file.
 */
function useShowsFixture(shows) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-fixture-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ shows: shows || [] }));
  const prev = process.env.SHOWS_JSON_PATH;
  process.env.SHOWS_JSON_PATH = file;
  return function restore() {
    if (prev === undefined) delete process.env.SHOWS_JSON_PATH; else process.env.SHOWS_JSON_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

module.exports = { useShowsFixture };
