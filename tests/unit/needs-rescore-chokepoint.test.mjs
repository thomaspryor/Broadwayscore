import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { markRescoreNeeded, isStaleScoreInput } = require('../../scripts/lib/rescore-flagging.js');
const root = fileURLToPath(new URL('../../', import.meta.url));

// Parse code so comments, help strings and comparison expressions cannot hide
// a new writer or masquerade as one. Include bracket notation and object keys.
test('only rescore-flagging.js writes needsRescore=true under scripts/', () => {
  const writers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(?:[cm]?js|tsx?)$/.test(file) || /\.test\./.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const key = (node) => {
        if (ts.isComputedPropertyName(node)) return key(node.expression);
        return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
      };
      function visit(node) {
        let name;
        let value;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isPropertyAccessExpression(node.left)) name = key(node.left.name);
          if (ts.isElementAccessExpression(node.left)) name = key(node.left.argumentExpression);
          value = node.right;
        } else if (ts.isPropertyAssignment(node)) {
          name = key(node.name);
          value = node.initializer;
        }
        if (name === 'needsRescore' && value?.kind === ts.SyntaxKind.TrueKeyword) {
          writers.push(path.relative(root, file).split(path.sep).join('/'));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk(path.join(root, 'scripts'));
  assert.deepEqual(writers, ['scripts/lib/rescore-flagging.js']);
});

test('default enqueue preserves the reason and timestamp of an existing queue entry', () => {
  const data = { needsRescore: true, rescoreReason: 'original', rescoreFlaggedAt: '2026-10-01T00:00:00Z' };
  const before = { ...data };
  assert.equal(markRescoreNeeded(data, 'later sweep', '2026-10-20T00:00:00Z'), data);
  assert.deepEqual(data, before);
});

test('explicit input invalidation requeues with a fresh stamp even if already queued', () => {
  const data = { needsRescore: true, rescoreReason: 'original', rescoreFlaggedAt: '2026-10-01T00:00:00Z' };
  assert.equal(markRescoreNeeded(data, 'text replaced', '2026-10-20T00:00:00Z', { requeue: true }), data);
  assert.equal(data.rescoreReason, 'text replaced');
  assert.equal(data.rescoreFlaggedAt, '2026-10-20T00:00:00Z');
  assert.equal(data.needsRescore, true);
});

test('explicit invalidation supports fullText scores and scoreless split children', () => {
  for (const data of [
    { assignedScore: 75, llmMetadata: { textSource: { type: 'fullText' } } },
    { contentTier: 'complete' },
  ]) {
    assert.equal(isStaleScoreInput(data), false);
    markRescoreNeeded(data, 'materially different input', '2026-10-20T00:00:00Z', { requeue: true });
    assert.equal(data.needsRescore, true);
    assert.equal(data.rescoreReason, 'materially different input');
  }
});
