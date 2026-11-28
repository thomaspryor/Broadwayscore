#!/usr/bin/env node
'use strict';

// BRO-2249: CI's test-file conventions must have an accepted card check.
// scripts/audit-test-file-extensions.test.mjs runs this in the CI/land node batch.
const fs = require('fs');
const path = require('path');
const { MANIFESTS } = require('./test-manifest.js');
const { manifestLines, treeUsesCollector, nodeUnitTestsForTree } = require('./unit-test-collection.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

const ROOT = path.resolve(__dirname, '..', '..');

function auditTestFileExtensions(root = ROOT) {
  // Inspect all three literal manifests, including the retired node list as
  // requested by the card. Also inspect the live collector so newly collected
  // conventions cannot hide behind that frozen list (BRO-2483).
  const sources = MANIFESTS.map(source => ({
    source,
    entries: manifestLines(fs.readFileSync(path.join(root, source), 'utf8')),
  }));
  if (treeUsesCollector(root)) {
    sources.push({ source: 'collected node batch', entries: nodeUnitTestsForTree(root) });
  }

  const examples = new Map();
  for (const { source, entries } of sources) {
    for (const file of entries) {
      const extension = path.extname(file);
      if (!examples.has(extension)) examples.set(extension, []);
      const refs = examples.get(extension);
      if (!refs.some(ref => ref.source === source)) refs.push({ source, file });
    }
  }
  const extensions = [...examples.keys()].sort().map(extension => {
    // Probe the real gate, including its path checks. Do not parse or copy
    // SAFE_CHECK_FORMS: accepting `test -f` is not an executable test check.
    const file = `tests/unit/congruence.test${extension}`;
    const commands = [`node --test ${file}`, `npx tsx --test ${file}`];
    return { extension, supported: commands.some(isSafeCheckCommand), examples: examples.get(extension) };
  });
  const unsupported = extensions.filter(item => !item.supported);
  return {
    ok: unsupported.length === 0,
    sources: sources.map(({ source, entries }) => ({ source, records: entries.length })),
    extensions,
    unsupported,
  };
}

function main() {
  try {
    const result = auditTestFileExtensions();
    for (const { source, records } of result.sources) console.log(`${source}: ${records} test files`);
    if (result.ok) {
      console.log(`PASS: SAFE_CHECK_FORMS covers ${result.extensions.map(item => item.extension).join(', ')}`);
    } else {
      for (const { extension, examples } of result.unsupported) {
        console.error(`FAIL: SAFE_CHECK_FORMS has no accepted test command for ${extension || '(no extension)'}`);
        for (const { source, file } of examples) console.error(`  ${source}: ${file}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`FAIL: test-file extension audit could not run: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { auditTestFileExtensions };
if (require.main === module) main();
