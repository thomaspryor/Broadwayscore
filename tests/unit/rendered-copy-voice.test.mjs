// BRO-5812: the owner's voice rules for on-screen copy. No em dashes, and none
// of the AI-flavored phrases (truly, robust, leverage, "serves as", "not just
// X, but Y"...). Comments and console messages are ignored; only strings that
// can render are checked. ADVISORY (CLAUDE.md section 19): runs at its own
// continue-on-error step in test.yml, not in the blocking unit batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { copyViolationsIn, listTsFiles } = require('../../scripts/lib/rendered-copy-voice.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the scanner flags rendered strings but not comments or console output', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmp = path.join(dir, 'x.tsx');
  fs.writeFileSync(tmp, [
    '// comment — fine',
    'const a = <p>Bad — copy</p>;',
    "const b = 'We truly care';",
    'const c = `robust ${a}`;',
    "console.warn('log — truly fine');",
    'const d = <p>Entity &mdash; bad</p>;',
    "const e = 'It serves as a guide';",
    "const f = 'Not just a score, but a verdict';",
    "const g = 'Clean sentence, no tropes.';",
  ].join('\n'));
  assert.deepEqual(copyViolationsIn(tmp, dir).map((h) => h.split(':')[1]), ['2', '3', '4', '6', '7', '8']);
});

test('on-screen copy in src/app and src/components follows the voice rules', () => {
  const hits = ['src/app', 'src/components'].flatMap((d) => listTsFiles(path.join(root, d)))
    .flatMap((f) => copyViolationsIn(f, root));
  assert.deepEqual(hits, [], `rewrite with commas, periods or parentheses, and plain wording:\n${hits.join('\n')}`);
});
