// Tests for the Phase 1 (BRO-377) Notion read-only guard.
//
// Two halves, and the second is the one that matters. The pure verdict is easy;
// what actually protects the migration is that notion-brain.js's ONE create
// call site consults it and exits non-zero, and that updates are NOT gated —
// a guard that also blocked updates would make notion-action-poll.js reprocess
// the same action forever and would strand every open Notion card unclosable.
//
// Structural assertions read the real source (the pattern
// scripts/autonomous-merge-core-data-guard.test.mjs established) so that
// deleting the wiring fails here, not silently in production six days later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Structural assertions must read CODE, not prose. The first version of this
// file searched the raw source and matched the guard's own explanatory comment
// — which necessarily quotes `notion.pages.create(` and the word REJECTED —
// so it reported the guard as mis-ordered when the code was correct. Strip
// comments first; a test that can be fooled by a comment proves nothing.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { notionCreateVerdict, ESCAPE_ENV } = require(join(HERE, 'notion-write-guard.js'));

test('refuses a create by default, and says what to do instead', () => {
  const v = notionCreateVerdict({});
  assert.equal(v.allowed, false);
  assert.match(v.reason, /READ-ONLY/);
  assert.match(v.reason, /linear-brain\.js create/, 'a refusal that does not name the alternative just gets worked around');
  assert.match(v.reason, /BRO-377/, 'name the card so the next reader can find out why');
});

test('the refusal tells the reader updates still work', () => {
  // Without this line someone reasonably concludes the whole board is frozen
  // and stops closing old cards, which is the opposite of draining it.
  assert.match(notionCreateVerdict({}).reason, /updated and closed/i);
});

test('the escape hatch is honoured, and is never silent', () => {
  const v = notionCreateVerdict({ [ESCAPE_ENV]: '1' });
  assert.equal(v.allowed, true);
  assert.ok(v.reason, 'an allowed-by-bypass verdict MUST carry a reason so the caller can log it');
  assert.match(v.reason, new RegExp(ESCAPE_ENV));
});

test('only the exact value "1" opens the hatch', () => {
  for (const val of ['0', 'true', 'yes', '', 'TRUE', ' 1']) {
    assert.equal(notionCreateVerdict({ [ESCAPE_ENV]: val }).allowed, false, `${JSON.stringify(val)} must not bypass`);
  }
});

test('the ordinary allowed path carries no reason to log', () => {
  // Guards the caller's `if (writeVerdict.reason)` logging branch: if a future
  // edit made every verdict carry a reason, every create would print a warning.
  const v = notionCreateVerdict({ [ESCAPE_ENV]: '1' });
  assert.equal(typeof v.reason, 'string');
  assert.equal(notionCreateVerdict({}).allowed, false);
});

test('the guard runs BEFORE every validation gate, not just before the API call', () => {
  // Regression for a wedge that hit a live session twice. The guard originally
  // sat just above notion.pages.create(), AFTER the notes-length /
  // acceptance-verifiability / disposition checks. Any card that failed one of
  // those emitted "REJECTED", which writes /tmp/notion-create-failed-<sid>, and
  // notion-create-block.sh then blocks every Bash call until a create SUCCEEDS
  // — impossible under read-only. Refusing first means read-only never emits
  // REJECTED at all.
  const src = stripComments(readFileSync(join(REPO, 'scripts', 'notion-brain.js'), 'utf8'));
  const fnIdx = src.indexOf('async function createCard(args) {');
  assert.ok(fnIdx > 0, 'createCard must exist');
  const guardIdx = src.indexOf('notionCreateVerdict(process.env)', fnIdx);
  assert.ok(guardIdx > 0, 'guard must be called inside createCard');

  // No REJECTED-emitting validation may precede the guard.
  const preamble = src.slice(fnIdx, guardIdx);
  assert.ok(
    !/REJECTED/.test(preamble),
    'a validation that can emit REJECTED runs before the read-only guard — that is the wedge this test exists to prevent'
  );
  // And it must be within the first few lines of the function.
  // Count CODE lines: stripComments leaves the comment's blank lines behind, so
  // a raw line count here would fail on a well-documented guard.
  const codeLines = preamble.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(
    codeLines.length < 4,
    `the guard drifted away from the top of createCard (${codeLines.length} code lines precede it); validation can now run first`
  );
});

test('notion-brain.js actually consults the guard at its create call site', () => {
  const src = stripComments(readFileSync(join(REPO, 'scripts', 'notion-brain.js'), 'utf8'));
  assert.match(src, /require\(['"]\.\/lib\/notion-write-guard['"]\)/, 'guard must be required');

  const createIdx = src.indexOf('notion.pages.create(');
  assert.ok(createIdx > 0, 'the create call site must exist — if this moved, re-point the guard');
  const guardIdx = src.indexOf('notionCreateVerdict(process.env)');
  assert.ok(guardIdx > 0, 'the guard must be CALLED, not merely imported');
  assert.ok(guardIdx < createIdx, 'the guard must run BEFORE the create, or it guards nothing');

  const between = src.slice(guardIdx, createIdx);
  assert.match(between, /process\.exit\(/, 'a refusal must actually stop the create');
});

test('updates and archives are deliberately NOT gated', () => {
  const src = stripComments(readFileSync(join(REPO, 'scripts', 'notion-brain.js'), 'utf8'));
  // Exactly one guard call: gating pages.update too would make
  // notion-action-poll.js reprocess actions forever (see the guard's header).
  const calls = src.match(/notionCreateVerdict\(/g) || [];
  assert.equal(calls.length, 1, `guard should be called once (at create), found ${calls.length}`);
  // Update path goes through the shared helper (BRO-2471), not the raw SDK
  // call directly — see the next test for why that matters.
  assert.ok(src.includes('updatePage(notion,'), 'update path should still exist and be ungated');
});

test('no script outside scripts/lib/notion-writes.js calls pages.update directly', () => {
  // BRO-2471: Phase 1's read-only guard worked because notion-brain.js has
  // exactly one create call site — a single chokepoint. Updates had none:
  // auto-fix-friction-card.js and notion-action-poll.js called
  // `notion.pages.update()` straight against the SDK, invisible to any guard
  // or counter placed at the CLI. scripts/lib/notion-writes.js's updatePage()
  // is now the one place that call is allowed to appear — this test fails
  // the moment a new direct call site is added anywhere under scripts/.
  const SCRIPTS_DIR = join(REPO, 'scripts');
  const HELPER_PATH = join(SCRIPTS_DIR, 'lib', 'notion-writes.js');
  const offenders = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (/\.test\.(js|mjs)$/.test(entry.name)) continue; // reference the pattern in prose/strings, not real calls
      if (full === HELPER_PATH) continue;
      const src = stripComments(readFileSync(full, 'utf8'));
      if (/\.pages\s*\.\s*update\s*\(/.test(src)) {
        offenders.push(full.slice(REPO.length + 1));
      }
    }
  }

  walk(SCRIPTS_DIR);
  assert.deepEqual(
    offenders,
    [],
    `these files call notion.pages.update() directly instead of scripts/lib/notion-writes.js's updatePage(): ${offenders.join(', ')}`
  );
});
