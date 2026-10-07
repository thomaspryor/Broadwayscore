// BRO-383 (Phase 3): memory/hooks-audit.md is the source of truth for the hook migration. Every hook script in the repo
// must appear in it with a decision (KEEP with a reason, or DELETE with its replacement), and nothing may be left
// undecided. The card's own acceptance check was `test -f memory/hooks-audit.md`, which passes on any file at all; this
// reads the document against the hooks that actually exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const doc = fs.readFileSync(path.join(ROOT, 'memory/hooks-audit.md'), 'utf8');

/** Table rows as {name, cells[]} (header and separator rows dropped). */
function rows(text) {
  return text.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\|\s*Hook\s*\|/.test(l)).map((l) => {
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    return { name: cells[0], cells, line: l };
  });
}
const all = rows(doc);
const section = (title) => {
  const start = doc.indexOf(title);
  assert.ok(start >= 0, `section "${title}" exists`);
  const next = doc.indexOf('\n## ', start + title.length);
  return rows(doc.slice(start, next < 0 ? undefined : next));
};
const hookFiles = (dir, filter) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => filter(f) && fs.statSync(path.join(ROOT, dir, f)).isFile());

test('every .claude/hooks script is in the project-hooks table', () => {
  const table = section('## Project hooks');
  const listed = new Set(table.map((r) => r.name));
  const missing = hookFiles('.claude/hooks', (f) => f.endsWith('.sh')).filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add these to memory/hooks-audit.md (KEEP with a reason, or DELETE with a replacement): ${missing.join(', ')}`);
});

test('every scripts/hooks git hook is in the git-hooks table', () => {
  const table = section('## Git hooks');
  const listed = new Set(table.map((r) => r.name));
  const missing = hookFiles('scripts/hooks', (f) => !f.startsWith('.') && !f.endsWith('.md')).filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `missing from the git-hooks table: ${missing.join(', ')}`);
});

test('every row is decided: KEEP with a reason or DELETE with a replacement, never blank or hedged', () => {
  assert.ok(all.length > 50, `expected the full inventory, found ${all.length} rows`);
  for (const r of all) {
    const status = r.cells.find((c) => /^(KEEP|DELETE)$/.test(c));
    assert.ok(status, `${r.name}: needs a KEEP or DELETE status (${r.line.slice(0, 80)})`);
    const reason = r.cells[r.cells.length - 1];
    assert.ok(reason && reason.length >= 15, `${r.name}: a ${status} needs its reason / replacement written out`);
    assert.ok(!/\b(unsure|uncertain|tbd|todo|maybe|might still be useful|not sure)\b/i.test(r.line), `${r.name}: hedged decision: ${r.line.slice(0, 100)}`);
  }
});

test('no hook is listed twice within one table, and every DELETE names what replaces it', () => {
  for (const title of ['## User-level hooks', '## Project hooks', '## Git hooks']) {
    const names = section(title).map((r) => r.name);
    assert.equal(new Set(names).size, names.length, `duplicate row in "${title}"`);
  }
  for (const r of all.filter((x) => x.cells.includes('DELETE'))) {
    const reason = r.cells[r.cells.length - 1];
    assert.match(reason, /[Rr]eplace|[Rr]eplacement|none needed|nothing left/, `${r.name}: a DELETE must name its replacement`);
  }
});

test('the totals line matches the tables', () => {
  const count = (title, status) => section(title).filter((r) => r.cells.includes(status)).length;
  const keptProject = count('## Project hooks', 'KEEP');
  assert.match(doc, new RegExp(`${keptProject} project \\(`), `the Totals section should say ${keptProject} project hooks kept`);
  assert.match(doc, new RegExp(`\\+ 3 git`));
  assert.equal(count('## Git hooks', 'KEEP'), 3);
});
