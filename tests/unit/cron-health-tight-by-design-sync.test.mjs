import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * BRO-3666 follow-up. scripts/audit-cron-health-coverage.js exempts an entry
 * from its cushion warning only when the TIGHT_BY_DESIGN map's maxHours
 * matches the band in check-cron-health.yml on STRICT EQUALITY:
 *
 *   } else if (tight && tight.maxHours === maxHours) {
 *
 * So 8 in the workflow and 9 in the map silently loses the exemption. Nothing
 * caught that: the audit only WARNS, and it needs `--strict` to exit non-zero —
 * which neither test.yml's step nor scripts/hooks/pre-push passes. A desync
 * therefore degrades to a yellow advisory line that CI is happy with, which is
 * exactly the state that invites a future session to "fix" the band toward the
 * generic worstGap + CUSHION_HOURS value and silently undo the deliberate
 * tightness.
 *
 * This test closes that hole by asserting the two sources agree. It reads both
 * real files — it does not re-declare the expected bands, so it cannot drift
 * away from what ships (CLAUDE.md rule 15).
 */

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'check-cron-health.yml');
const AUDIT_PATH = path.join(REPO_ROOT, 'scripts', 'audit-cron-health-coverage.js');

/**
 * Parse the CRITICAL_CRONS bash array out of check-cron-health.yml.
 * Entry format (documented in the workflow): "file|max_hours|Friendly Name[|active_months]".
 * Returns Map<filename, maxHours:number>.
 */
function readWorkflowBands() {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const bands = new Map();
  // Only quoted entry lines — skips the surrounding prose comments, which in
  // this file are long and DO mention bare filenames and hour numbers.
  const re = /^\s*"([A-Za-z0-9._-]+\.yml)\|(\d+)\|/gm;
  let m;
  while ((m = re.exec(src)) !== null) bands.set(m[1], Number(m[2]));
  return bands;
}

/** The real TIGHT_BY_DESIGN map, read from the module rather than copied. */
function readTightByDesign() {
  const src = fs.readFileSync(AUDIT_PATH, 'utf8');
  const start = src.indexOf('const TIGHT_BY_DESIGN = {');
  assert.notEqual(start, -1, 'could not find TIGHT_BY_DESIGN in audit-cron-health-coverage.js — was it renamed?');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, 'could not find the end of the TIGHT_BY_DESIGN object literal');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end)};`)();
}

test('sanity: both sources parse and are non-empty (proves the test is actually reading real data)', () => {
  const bands = readWorkflowBands();
  const tight = readTightByDesign();
  assert.ok(bands.size > 10, `expected many CRITICAL_CRONS entries, parsed ${bands.size}`);
  assert.ok(Object.keys(tight).length > 0, 'expected at least one TIGHT_BY_DESIGN entry');
});

test('every TIGHT_BY_DESIGN entry names a workflow that is actually in CRITICAL_CRONS', () => {
  const bands = readWorkflowBands();
  const tight = readTightByDesign();
  const orphans = Object.keys(tight).filter((wf) => !bands.has(wf));
  assert.deepEqual(
    orphans,
    [],
    'a TIGHT_BY_DESIGN entry for a workflow with no CRITICAL_CRONS band is dead config — it exempts nothing',
  );
});

test('every TIGHT_BY_DESIGN maxHours equals the band shipped in check-cron-health.yml', () => {
  const bands = readWorkflowBands();
  const tight = readTightByDesign();
  const mismatches = Object.entries(tight)
    .filter(([wf]) => bands.has(wf))
    .filter(([wf, cfg]) => cfg.maxHours !== bands.get(wf))
    .map(([wf, cfg]) => `${wf}: workflow says ${bands.get(wf)}h, TIGHT_BY_DESIGN says ${cfg.maxHours}h`);
  assert.deepEqual(
    mismatches,
    [],
    'audit-cron-health-coverage.js matches these on strict equality (`tight.maxHours === maxHours`), so a mismatch '
      + 'silently drops the cushion exemption and the entry goes back to a permanent yellow warning that CI ignores',
  );
});

test('every TIGHT_BY_DESIGN entry carries a non-trivial `why`', () => {
  const tight = readTightByDesign();
  const weak = Object.entries(tight)
    .filter(([, cfg]) => typeof cfg.why !== 'string' || cfg.why.trim().length < 20)
    .map(([wf]) => wf);
  assert.deepEqual(
    weak,
    [],
    'the `why` is printed verbatim by the audit as the justification for skipping the cushion check — an empty or '
      + 'one-word reason makes the exemption unauditable',
  );
});
