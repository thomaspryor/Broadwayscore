/**
 * BRO-8016 class guard. The external-reviewer curls in skill docs (ship-check UX reviewer,
 * right-problem challenger, plan-review Gemini fallback) build their request with an inline
 * `jq -n --arg x "$(...)" '<program>'`. All three were broken on main and nobody noticed:
 * an apostrophe in the prompt text ("don't", 'but that is only...') closes the shell's single
 * quote, and plan-review's program was also missing a `]`. Sessions copy these lines verbatim,
 * so a broken one silently drops a reviewer. This compiles every such program with real jq.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The program is what the shell passes: everything up to the next single quote.
const JQ_CALL = /jq -n((?:\s+--arg \w+ "\$\([\s\S]*?\)")*)\s+'([^']*)'/g;
const HAVE_JQ = spawnSync('jq', ['--version']).status === 0;

export function jqPrograms(text) {
  return [...text.matchAll(JQ_CALL)].map((m) => ({ names: [...m[1].matchAll(/--arg (\w+)/g)].map((x) => x[1]), program: m[2] }));
}
const compiles = ({ names, program }) => spawnSync('jq', ['-n', ...names.flatMap((n) => ['--arg', n, 'x']), program], { encoding: 'utf8' }).status === 0;

function docs() {
  const out = [];
  const cmd = path.join(ROOT, '.claude/commands');
  for (const f of fs.readdirSync(cmd)) if (f.endsWith('.md')) out.push(path.join(cmd, f));
  for (const base of ['.claude/skills', '.agents/skills']) {
    const sk = path.join(ROOT, base);
    if (fs.existsSync(sk)) for (const d of fs.readdirSync(sk)) { const p = path.join(sk, d, 'SKILL.md'); if (fs.existsSync(p)) out.push(p); }
  }
  return out;
}

test('every inline jq request program in a skill doc compiles', { skip: !HAVE_JQ && 'jq not installed' }, () => {
  const found = docs().flatMap((p) => jqPrograms(fs.readFileSync(p, 'utf8')).map((j) => ({ ...j, file: path.relative(ROOT, p) })));
  assert.ok(found.length >= 3, `expected the ship-check, right-problem and plan-review curls, found ${found.length}`);
  const bad = found.filter((j) => !compiles(j)).map((j) => j.file);
  // A `jq -n` request in a form JQ_CALL does not parse (--arg x "$VAR", --argjson, --rawfile) fails
  // loudly here instead of being skipped: extend JQ_CALL for it.
  const unparsed = docs().filter((p) => { const t = fs.readFileSync(p, 'utf8'); return (t.match(/jq -n\b/g) || []).length !== jqPrograms(t).length; }).map((p) => path.relative(ROOT, p));
  assert.deepEqual(unparsed, [], `jq -n call this guard cannot parse: ${unparsed.join(', ')}`);
  assert.deepEqual(bad, [], `jq program does not compile (an apostrophe in the prompt ends the shell quote?): ${bad.join(', ')}`);
});

test('the check catches the two breaks it was written for (red-then-green)', { skip: !HAVE_JQ && 'jq not installed' }, () => {
  const apostrophe = jqPrograms(`jq -n --arg p "$(cat f)" '{a: [{t: ("steps that don't say so" + $p)}]}'`);
  assert.equal(compiles(apostrophe[0]), false);
  const bracket = jqPrograms(`jq -n --arg p "$(cat f)" '{a: [{b: [{t: ("x" + $p)}]}\n}'`);
  assert.equal(compiles(bracket[0]), false);
  const good = jqPrograms(`jq -n --arg p "$(cat f)" '{a: [{b: [{t: ("do not say \\"so\\"" + $p)}]}]}'`);
  assert.equal(compiles(good[0]), true);
});
