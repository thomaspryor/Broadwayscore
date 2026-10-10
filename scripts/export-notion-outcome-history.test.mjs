import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'export-notion-outcome-history.js');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bro376-export-${name}-`));
}

function writeCorpus(dir, manifest) {
  fs.writeFileSync(
    path.join(dir, 'corpus.ndjson'),
    `${JSON.stringify({ id: 'p1', url: 'https://notion.so/p1', properties: { Name: 'X', Status: 'Done', Priority: 'P1 Next' }, fields: { outcome: 'closed', notes: '', keyFiles: '' } })}\n`
  );
  if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

// Code-review finding, BRO-376: the manifest-completeness guard used to be
// gated on `--corpus` being a DIRECTORY, and this tool's own remediation text
// for a count mismatch tells the user to "point --corpus at the published
// .gz" — a FILE. Following that advice silently skipped every manifest
// protection (partial, errorCount, count-mismatch) it exists to provide.
test('CLI: manifest check still runs when --corpus points at a FILE, not a directory (bypass closed)', () => {
  const dir = tmpDir('file-input');
  writeCorpus(dir, { partial: true, errorCount: 0, pagesExported: 1 });
  const outPath = path.join(tmpDir('out'), 'history.jsonl');

  assert.throws(() => {
    execFileSync(
      process.execPath,
      [CLI, `--corpus=${path.join(dir, 'corpus.ndjson')}`, `--out=${outPath}`],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }, (err) => {
    assert.match(err.stderr || '', /PARTIAL/);
    return true;
  });
});

test('CLI: --skip-manifest-check proceeds without a manifest.json (fixtures only)', () => {
  const dir = tmpDir('no-manifest');
  writeCorpus(dir, null);
  const outPath = path.join(tmpDir('out2'), 'history.jsonl');

  execFileSync(
    process.execPath,
    [CLI, `--corpus=${dir}`, `--out=${outPath}`, '--skip-manifest-check'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const rows = fs.readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageId, 'p1');
});

test('CLI: without --skip-manifest-check, a missing manifest.json is a fatal error', () => {
  const dir = tmpDir('no-manifest-fatal');
  writeCorpus(dir, null);
  const outPath = path.join(tmpDir('out3'), 'history.jsonl');

  assert.throws(() => {
    execFileSync(
      process.execPath,
      [CLI, `--corpus=${dir}`, `--out=${outPath}`],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });
});
