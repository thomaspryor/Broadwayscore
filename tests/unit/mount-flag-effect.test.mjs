/**
 * A "still mounted" ref must be set back to true inside its effect.
 *
 * reactStrictMode is on, so in development React mounts, unmounts and
 * remounts every component. A ref that starts true and is only ever set false
 * in a cleanup (useEffect(() => () => { mounted.current = false; }, [])) stays
 * false after that, and anything gated on it silently never runs: the welcome
 * sheet (WelcomeGate) never opened in a dev build. Run:
 *   node --test tests/unit/mount-flag-effect.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../src/', import.meta.url).pathname;
// A cleanup-only effect whose whole body clears a ref.
const CLEANUP_ONLY = /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*\w+\.current\s*=\s*false;?\s*\}/;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });
}

test('the pattern is recognised', () => {
  assert.match('useEffect(() => () => { mounted.current = false; }, []);', CLEANUP_ONLY);
  assert.doesNotMatch('useEffect(() => {\n  mounted.current = true;\n  return () => { mounted.current = false; };\n}, []);', CLEANUP_ONLY);
});

test('no src file clears a mount flag in a cleanup-only effect', () => {
  const offenders = sourceFiles(ROOT).filter(f => CLEANUP_ONLY.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map(f => f.slice(ROOT.length)), [],
    'Set the ref to true in the effect body too: useEffect(() => { ref.current = true; return () => { ref.current = false; }; }, [])');
});
