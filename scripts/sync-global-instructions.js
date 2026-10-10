#!/usr/bin/env node
/**
 * sync-global-instructions.js — cloud session-start installer for the owner's
 * global instructions (BRO-4237; see scripts/lib/global-instructions.js).
 *
 *   node scripts/sync-global-instructions.js install [--home DIR]
 *
 * Always exits 0 with one line: it runs inside a SessionStart hook and must
 * never block a session.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installForCloud } = require('./lib/global-instructions.js');

// Test seam: read the source files from a local dir instead of GitHub.
// Production never sets it.
const FROM_DIR = process.env.GLOBAL_INSTRUCTIONS_FROM_DIR;
const localFetch = async (name) => {
  try { return { text: fs.readFileSync(path.join(FROM_DIR, name), 'utf8'), reason: null }; } catch (err) { return { text: null, reason: err.code || 'unreadable' }; }
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  if (process.argv[2] !== 'install') {
    console.log('usage: sync-global-instructions.js install [--home DIR]');
    return;
  }
  try {
    const r = await installForCloud({ homeDir: arg('home', os.homedir()), ...(FROM_DIR ? { fetchFn: localFetch } : {}) });
    const skipped = r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ');
    console.log(`global instructions: installed ${r.installed.join(', ') || 'none'}`
      + (r.unchanged.length ? `; unchanged ${r.unchanged.join(', ')}` : '')
      + (skipped ? `; skipped ${skipped}` : ''));
  } catch (err) {
    console.log(`global instructions: install failed: ${String(err.message).split('\n')[0]}`);
  }
})();
