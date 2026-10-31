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

// Season Report and /biz were rewritten in BRO-5808 and keep their own table placeholders.
const SKIP = [
  'src/app/season-report', 'src/components/biz',
  // Shared with /biz and the Season Report, whose "—" placeholders are pinned by tests/unit/biz-format.test.ts.
  'src/lib/biz-format.ts', 'src/lib/season-profile.ts', 'src/config/commercial.ts',
  // Analytics enum values and data-* attribute names, identifiers rather than copy ("unlocked" is the gate's own state name).
  'src/lib/money-gate.ts',
  // Citation notes and dev sample strings, not site copy.
  'src/lib/olivier-cutoffs.ts', 'src/lib/tony-cutoffs.ts', 'src/lib/gate-logic.ts', 'src/lib/formatting.ts',
];
// "Unlock" is the literal name of the admin action that removes a score lock.
const UNLOCK_ACTION = /^src\/(app\/admin\/locks|app\/api\/admin\/lock-score)/;

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
    "const j = 'Name – Title';",
    "const k = '–';",
    'const h = <p>You&apos;ll be fine, they&apos;re here</p>;',
    'const i = <p>YouYou&apos;ll navigateapos;ll move</p>;',
  ].join('\n'));
  assert.deepEqual(copyViolationsIn(tmp, dir).map((h) => h.split(':')[1]), ['2', '3', '4', '6', '7', '8', '10', '13']);
});

test('on-screen copy in src/app, src/components, src/config and src/lib follows the voice rules', () => {
  const hits = ['src/app', 'src/components', 'src/config', 'src/lib', 'src/sanity', 'src/contexts', 'src/hooks'].flatMap((d) => listTsFiles(path.join(root, d)))
    .filter((f) => !SKIP.some((s) => path.relative(root, f).startsWith(s)))
    .flatMap((f) => copyViolationsIn(f, root))
    .filter((h) => !(UNLOCK_ACTION.test(h.split(':')[0]) && /unlock/i.test(h)));
  assert.deepEqual(hits, [], `rewrite with commas, periods or parentheses, and plain wording:\n${hits.join('\n')}`);
});
