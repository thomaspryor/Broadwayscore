// Every `run:` block in .github/actions/*/action.yml must parse as bash.
// BRO-5337: an apostrophe in a comment inside `node -e '...'` ended the quote and broke
// the whole push-core-data step; nothing else parsed the script before it ran in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, '.github/actions');

for (const name of fs.readdirSync(dir)) {
  const f = path.join(dir, name, 'action.yml');
  if (!fs.existsSync(f)) continue;
  test(`${name}/action.yml run blocks parse as bash`, () => {
    const doc = yaml.load(fs.readFileSync(f, 'utf8'));
    for (const [i, step] of ((doc.runs && doc.runs.steps) || []).entries()) {
      if (!step.run) continue;
      const script = step.run.replace(/\$\{\{[^}]*\}\}/g, 'X');
      const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      assert.equal(r.status, 0, `step ${i} (${step.name || 'unnamed'}): ${r.stderr}`);
    }
  });
}
