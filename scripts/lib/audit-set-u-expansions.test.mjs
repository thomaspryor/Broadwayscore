// BRO-2555: set -u + empty array = "unbound variable" on macOS bash 3.2.
// Real functions via require() (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { usesSetU, auditSource, alwaysNonEmptyArrays, sourcedByNounset, main } = require('./audit-set-u-expansions.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETU = '#!/usr/bin/env bash\nset -euo pipefail\n';

test('usesSetU: detects -u in combined flags, -o nounset and a -u shebang; ignores set -e', () => {
  assert.equal(usesSetU('set -euo pipefail\n'), true);
  assert.equal(usesSetU('set -u\n'), true);
  assert.equal(usesSetU('set -e -o nounset\n'), true);
  assert.equal(usesSetU('#!/bin/bash -eu\n'), true);
  assert.equal(usesSetU('set -e\n'), false);
});

test('auditSource: flags a bare "${arr[@]}" and ${arr[*]} on a possibly-empty array', () => {
  const f = auditSource(`${SETU}arr=()\nfor x in "\${arr[@]}"; do :; done\necho "\${arr[*]}"\n`);
  assert.deepEqual(f.map((x) => [x.line, x.kind, x.name]), [[4, 'array', 'arr'], [5, 'array', 'arr']]);
});

test('auditSource: guarded forms, counts, keys and slices under a guard are not flagged', () => {
  const src = `${SETU}arr=()\n`
    + 'for x in ${arr[@]+"${arr[@]}"}; do :; done\n'
    + 'echo "${#arr[@]} ${!arr[@]} ${arr[*]:-} ${arr[@]-none}"\n'
    + 'for x in ${arr[@]+"${arr[@]:1}"}; do :; done\n';
  assert.deepEqual(auditSource(src), []);
});

test('auditSource: literal non-empty arrays are safe, ones built from $(...) or read -a are not', () => {
  assert.deepEqual(auditSource(`${SETU}W=(a b c)\nfor w in "\${W[@]}"; do :; done\n`), []);
  assert.equal(auditSource(`${SETU}W=($(ls))\nfor w in "\${W[@]}"; do :; done\n`).length, 1);
  assert.equal(auditSource(`${SETU}W=(a)\nread -r -a W <<< "$x"\nfor w in "\${W[@]}"; do :; done\n`).length, 1);
  assert.equal(alwaysNonEmptyArrays(['local W', 'W=(a)']).has('W'), false, 'declared without a value first');
});

test('auditSource: a # set-u-safe: annotation within 3 lines silences a site; a bare # does not', () => {
  assert.deepEqual(auditSource(`${SETU}a=()\n# set-u-safe: filled above\nfor x in "\${a[@]}"; do :; done\n`), []);
  assert.equal(auditSource(`${SETU}a=()\n# set-u-safe:\nfor x in "\${a[@]}"; do :; done\n`).length, 1);
});

test('auditSource: comments and quoted-heredoc bodies are ignored; scripts without set -u are skipped', () => {
  assert.deepEqual(auditSource(`${SETU}a=()\n# for x in "\${a[@]}"\ncat <<'EOF'\n\${a[@]}\nEOF\n`), []);
  assert.deepEqual(auditSource('#!/bin/bash\nset -e\na=()\necho "${a[@]}"\n'), []);
});

test('auditSource: positional-fed variable in arithmetic is flagged unless validated (BRO-2554 shape)', () => {
  const bad = `${SETU}MAX=\${1:-7}\nN=$((MAX + 1))\n`;
  assert.deepEqual(auditSource(bad).map((x) => [x.kind, x.name]), [['arithmetic', 'MAX']]);
  assert.deepEqual(auditSource(`${SETU}MAX=\${1:-7}\n[[ "$MAX" =~ ^[0-9]+$ ]] || exit 2\nN=$((MAX + 1))\n`), []);
  assert.deepEqual(auditSource(`${SETU}MAX=\${1:-7}\nif [[ ! "$MAX" =~ ^[0-9]+$ ]]; then exit 2; fi\nN=$((MAX + 1))\n`), []);
});

test('review fixes: unquoted heredoc bodies expand, quoted ones and \$ escapes do not', () => {
  assert.equal(auditSource(`${SETU}a=()\ncat <<EOF\n\${a[@]}\nEOF\n`).length, 1, '<<EOF expands ${a[@]}');
  assert.deepEqual(auditSource(`${SETU}a=()\ncat <<'EOF'\n\${a[@]}\nEOF\n`), []);
  assert.deepEqual(auditSource(`${SETU}a=()\ncat <<EOF\n\\\${a[@]}\nEOF\n`), [], 'escaped dollar is literal');
});

test('review fixes: multi-line literal arrays are non-empty; local "$1" is not CLI input; -o errexit -o nounset is set -u', () => {
  assert.deepEqual(auditSource(`${SETU}W=(\n  a\n  b\n)\nfor w in "\${W[@]}"; do :; done\n`), []);
  assert.deepEqual(auditSource(`${SETU}f() {\n  local n="$1"\n  echo $((n * 2))\n}\n`), []);
  assert.equal(usesSetU('set -o errexit -o nounset\n'), true);
});

test('BRO-5261 retro-review: an unquoted glob literal can be empty; a quoted * cannot', () => {
  assert.deepEqual(auditSource(`${SETU}shopt -s nullglob\nt=(scripts/*.mjs)\nnode "${'$'}{t[@]}"\n`).map((f) => f.name), ['t']);
  assert.deepEqual(auditSource(`${SETU}a=(-path '*/x' -o -name "*.y")\nfind . "${'$'}{a[@]}"\n`), []);
});

test('BRO-5261 retro-review: a << in a trailing comment or an arithmetic shift opens no heredoc', () => {
  const tail = `# example: "${'$'}{arr[@]}"\n`;
  assert.deepEqual(auditSource(`${SETU}x=1 # see <<EOF usage\n${tail}`), []);
  assert.deepEqual(auditSource(`${SETU}m=$(( 1 << bits ))\n${tail}`), []);
  // A real unquoted heredoc still expands its body.
  assert.equal(auditSource(`${SETU}cat <<EOF\n${'$'}{arr[@]}\nEOF\n`).length, 1);
});

test('BRO-5261 retro-review: a file sourced by a set -u script inherits nounset (arrays only)', () => {
  const caller = `${SETU}source "$DIR/lib/helper.sh"\n. ./other.sh # comment\n. "$(dirname "\${BASH_SOURCE[0]}")/lib/gh-runs-query.sh"\n`;
  assert.deepEqual([...sourcedByNounset([caller, 'source not-setu.sh\n'])].sort(), ['gh-runs-query.sh', 'helper.sh', 'other.sh']);
  const lib = 'f() { for x in "${a[@]}"; do :; done; echo $(( $1 + 1 )); }\nN=$1\necho $((N+1))\n';
  assert.deepEqual(auditSource(lib), []);
  assert.deepEqual(auditSource(lib, { inheritsSetU: true }).map((f) => f.kind), ['array']);
});

test('<<\EOF is a quoted heredoc: its body is literal', () => {
  assert.deepEqual(auditSource(`${SETU}a=()\ncat <<\\EOF\n\${a[@]}\nEOF\n`), []);
  assert.equal(auditSource(`${SETU}a=()\ncat <<\\EOF\nx\nEOF\necho "\${a[@]}"\n`).length, 1, 'scan resumes after the heredoc');
});

test('the live repo is clean: every set -u site is guarded or annotated (regression lock)', () => {
  const lines = [];
  const rc = main(['--strict'], { repoRoot: REPO_ROOT, log: (l) => lines.push(l) });
  assert.equal(rc, 0, lines.join('\n'));
});

test('--help prints usage and does no work', () => {
  const lines = [];
  assert.equal(main(['--help'], { repoRoot: '/nonexistent', log: (l) => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /Usage/);
});
