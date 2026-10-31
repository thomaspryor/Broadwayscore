// BRO-5803: workflows pick a mode by comparing github.event.schedule to a literal
// cron string. Moving a cron without updating the literal silently routes every
// run to the fallback branch (enrich-west-end-dates.yml's Thursday `enrich` arm).
// Every literal compared against github.event.schedule must be one of the
// workflow's own `on.schedule` crons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const wfDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));

const cronsOf = (raw) => new Set([...raw.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1].trim()));

// `"${{ github.event.schedule }}" = "30 2 * * 4"`, `github.event.schedule == '0 2 * * 1'`
// and the reversed forms; only strings that look like 5-field crons count.
function scheduleLiterals(raw) {
  const out = [];
  const pats = [
    /github\.event\.schedule\s*\}?\}?["']?\s*(?:!==?|===?|=)\s*["']([^"']+)["']/g,
    /["']([^"']+)["']\s*(?:!==?|===?|=)\s*["']?\$?\{?\{?\s*github\.event\.schedule/g,
  ];
  for (const re of pats) for (const m of raw.matchAll(re)) {
    if (m[1].trim().split(/\s+/).length === 5) out.push(m[1].trim());
  }
  return out;
}

test('scan finds the enrich-west-end-dates Thursday selector (guards an empty scan)', () => {
  const raw = readFileSync(join(wfDir, 'enrich-west-end-dates.yml'), 'utf8');
  assert.ok(scheduleLiterals(raw).includes('30 2 * * 4'));
});

test('every github.event.schedule literal matches one of the workflow crons', () => {
  const problems = [];
  for (const f of files) {
    const raw = readFileSync(join(wfDir, f), 'utf8');
    const crons = cronsOf(raw);
    for (const lit of scheduleLiterals(raw)) {
      if (!crons.has(lit)) problems.push(`${f}: compares github.event.schedule to "${lit}", which is not one of its crons (${[...crons].join(' | ') || 'none'})`);
    }
  }
  assert.deepEqual(problems, []);
});
