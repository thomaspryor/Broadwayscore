// BRO-4994: each cloud routine prompt says "read and follow
// docs/cloud-routines/<name>.md; if missing, end with routine doc missing".
// /docs/* is gitignored, so these files never reached main and every firing
// did nothing. This pins that each doc exists, is not ignored, and is a
// runnable one-firing script (has a reply or finish step), and that the .gitignore
// exception stays in place for docs added later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'cloud-routines');

// The doc names the server-side routine prompts point at (list_triggers,
// 2026-10-12). Add a name here when a new routine prompt names a new doc.
const ROUTINE_DOCS = [
  'board-workers',
  'cloud-worker-check',
  'morning-email',
  'opening-night-backup',
  'sunday-newsletter-review',
  'weekly-retro',
];

// Docs no routine reads: records of routines whose prompts live inline on the
// server, kept so config/mac-retired.json replacedBy can point at something
// checkable (BRO-6216). Not runnable scripts, so no Reply/Finish step.
const RECORD_DOCS = [
  'opening-night-watch',
];

function isIgnored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT, stdio: 'ignore' });
    return true; // exit 0 = ignored
  } catch {
    return false;
  }
}

for (const name of ROUTINE_DOCS) {
  test(`docs/cloud-routines/${name}.md exists and is not gitignored`, () => {
    const rel = `docs/cloud-routines/${name}.md`;
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing; its routine ends with "routine doc missing"`);
    assert.equal(isIgnored(rel), false, `${rel} is gitignored, so it would never reach main`);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.length > 400, `${rel} is too short to be a routine script`);
    assert.match(body, /^## \d+\. (Reply|Finish)/m, `${rel} needs a numbered "Reply" (or "Finish") step`);
  });
}

for (const name of RECORD_DOCS) {
  test(`docs/cloud-routines/${name}.md (record) exists and is not gitignored`, () => {
    const rel = `docs/cloud-routines/${name}.md`;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
    assert.equal(isIgnored(rel), false, `${rel} is gitignored, so it would never reach main`);
  });
}

test('a new doc under docs/cloud-routines/ is not gitignored', () => {
  assert.equal(isIgnored('docs/cloud-routines/some-future-routine.md'), false);
});

test('every doc in docs/cloud-routines/ is listed (no orphan routine docs)', () => {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(onDisk, [...ROUTINE_DOCS, ...RECORD_DOCS].sort());
});
