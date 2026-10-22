// BRO-5883: GitLab mirror jobs conclude "cancelled" on timeout, which skips bare
// `if: failure()` notify steps. Every mirror-*-to-gitlab workflow's checkout+notify
// steps must cover cancelled().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => /^mirror-.*gitlab\.yml$/.test(f));

test('finds the three GitLab mirror workflows', () => {
  assert.ok(files.length >= 3, `found ${files.join(',')}`);
});

for (const file of files) {
  test(`${file}: checkout + notify steps cover cancelled()`, () => {
    const doc = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf-8'));
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps || []);
    const gated = steps.filter((s) => /notify-failure/.test(String(s.uses || '')) || /notify action/i.test(String(s.name || '')));
    assert.ok(gated.length >= 2, 'expected checkout + notify steps');
    assert.equal(steps[steps.length - 1].uses, './.github/actions/notify-failure', `${file}: notify must be the last step so a failing verify step alerts`);
    for (const s of gated) assert.match(String(s.if), /cancelled\(\)/, `${file} / ${s.name}: if=${s.if}`);
  });
}
