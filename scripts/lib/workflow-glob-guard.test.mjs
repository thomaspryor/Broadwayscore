import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readWorkflowFilesOrFailClosed, TOO_FEW_WORKFLOWS_PREFIX, MIN_EXPECTED_WORKFLOWS } = require('./workflow-glob-guard.js');

function makeWorkflowDir(count) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-glob-guard-'));
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(dir, '.github/workflows', `wf-${i}.yml`), 'name: x\n');
  }
  return path.join(dir, '.github/workflows');
}

test('returns the .yml file list when the tree is a real size', () => {
  const dir = makeWorkflowDir(MIN_EXPECTED_WORKFLOWS);
  try {
    const files = readWorkflowFilesOrFailClosed(dir);
    assert.equal(files.length, MIN_EXPECTED_WORKFLOWS);
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('throws a __TOO_FEW_WORKFLOWS__ sentinel instead of returning a near-empty list', () => {
  const dir = makeWorkflowDir(3);
  try {
    assert.throws(
      () => readWorkflowFilesOrFailClosed(dir),
      (err) => err.message === `${TOO_FEW_WORKFLOWS_PREFIX}3`
    );
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('non-.yml files are excluded from both the list and the floor count', () => {
  const dir = makeWorkflowDir(3);
  writeFileSync(path.join(dir, 'README.md'), 'not a workflow\n');
  try {
    assert.throws(
      () => readWorkflowFilesOrFailClosed(dir),
      (err) => err.message === `${TOO_FEW_WORKFLOWS_PREFIX}3`
    );
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
