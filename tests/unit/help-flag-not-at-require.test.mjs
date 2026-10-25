/**
 * A script that exports functions must not exit on --help at load time
 * (BRO-5321): any importer run with --help printed the wrong usage and exited
 * (send-morning-digest.js --help printed check-provider-spend's usage).
 * Guard the help check with require.main === module, or move it into main().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPTS = path.join(process.cwd(), 'scripts');
const TOP_LEVEL_HELP_EXIT = /^if \(\s*hasHelpFlag\(process\.argv\)\s*\)/m;

test('exporting scripts check --help only when run directly', () => {
  const bad = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => {
      const s = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
      return /module\.exports/.test(s) && TOP_LEVEL_HELP_EXIT.test(s);
    });
  assert.deepEqual(bad, []);
});
