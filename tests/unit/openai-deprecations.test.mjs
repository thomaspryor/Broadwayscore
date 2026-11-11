// BRO-7339: the OpenAI shutdown drift check. Requires the real helpers (rule 15).
// The fixture rows are copied from developers.openai.com/api/docs/deprecations (2026-11-11).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { parseShutdownDate, baseId, parseDeprecations, referencedModelIds, driftReport } = require('../../scripts/lib/openai-deprecations');
const { decideOpenAiRetirementAlerts, INPUT_MISSING_KEY, UNREGISTERED_KEY } = require('../../scripts/lib/openai-retirement-alert');
const { MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS } = require('../../scripts/lib/research-cost');

const row = (date, ids, rep) => `<tr><td>${date}</td><td>${ids.map((i) => `<code>${i}</code>`).join(', ')}</td><td><code>${rep}</code></td></tr>`;
const FIXTURE = `<table><thead><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr></thead><tbody>
${row('December 11, 2026', ['gpt-5-mini', 'gpt-5-mini-2025-08-07'], 'gpt-5.6-terra')}
${row('December 11, 2026', ['o3'], 'gpt-5.6-sol')}
${row('January 14, 2027', ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'], 'gpt-6-luna')}
${row('October 23, 2026', ['gpt-4o-2024-05-13'], 'gpt-5.6-sol')}
${row('2026-02-17', ['chatgpt-4o-latest'], 'gpt-5.1-chat-latest')}
</tbody></table>`;

describe('parseShutdownDate', () => {
  it('reads the page date styles', () => {
    assert.equal(parseShutdownDate('Dec 11, 2026'), '2026-12-11');
    assert.equal(parseShutdownDate('February 10, 2027'), '2027-02-10');
    assert.equal(parseShutdownDate('2026-02-17'), null, 'ISO dates are not a table style here');
    assert.equal(parseShutdownDate('Shutdown date'), null);
  });
});

describe('parseDeprecations', () => {
  const rows = parseDeprecations(FIXTURE);
  it('skips the header row and keeps every dated model row', () => {
    assert.equal(rows.length, 4); // ISO-dated legacy row is not parseable and is skipped
    assert.deepEqual(rows[0], { shutdown: '2026-12-11', ids: ['gpt-5-mini', 'gpt-5-mini-2025-08-07'], replacement: 'gpt-5.6-terra' });
  });
  it('returns nothing for a shell page, which the CLI reports as input-missing', () => {
    assert.equal(parseDeprecations('<html><body>Just a moment...</body></html>').length, 0);
  });
});

describe('referencedModelIds', () => {
  it('finds quoted OpenAI ids and folds snapshots to the alias', () => {
    const ids = referencedModelIds(`const a = 'gpt-5-mini'; const b = "gpt-4o-2024-08-06"; x = \`o3\`; y = 'claude-sonnet-4-6'; z = 'o3-deep-research'`);
    assert.deepEqual([...ids].sort(), ['gpt-4o', 'gpt-5-mini', 'o3', 'o3-deep-research']);
    assert.equal(baseId('gpt-5-mini-2025-08-07'), 'gpt-5-mini');
  });
});

describe('driftReport', () => {
  const page = parseDeprecations(FIXTURE);
  const today = '2026-11-11';
  const run = (registry, referenced) => driftReport({ page, registry, referenced, today });

  it('flags a referenced model the registry does not know (the gpt-5-mini case)', () => {
    const r = run({}, ['gpt-5-mini', 'o3']);
    assert.deepEqual(r.missing.map((m) => m.id), ['gpt-5-mini', 'o3']);
    assert.equal(r.missing[0].replacement, 'gpt-5.6-terra');
    assert.equal(r.missing[0].daysLeft, 30);
  });
  it('is quiet once the registry matches the page', () => {
    const r = run({ 'gpt-5-mini': '2026-12-11', o3: '2026-12-11' }, ['gpt-5-mini', 'o3']);
    assert.deepEqual([r.missing, r.dateDrift], [[], []]);
  });
  it('reports a date OpenAI moved', () => {
    const r = run({ o3: '2026-09-01' }, ['o3']);
    assert.deepEqual(r.dateDrift, [{ id: 'o3', registry: '2026-09-01', page: '2026-12-11' }]);
  });
  it('ignores models the repo does not reference', () => {
    assert.deepEqual(run({}, ['gpt-5.6-terra']).missing, []);
  });
  it('does not read a retired snapshot as the alias retiring (gpt-4o-2024-05-13 vs gpt-4o)', () => {
    const r = run({}, ['gpt-4o']);
    assert.equal(r.missing[0].shutdown, '2027-01-14', 'the alias follows its newest snapshot');
    assert.deepEqual(r.soon, [], 'a date already in the past is not a countdown');
  });
  it('lists only future shutdowns inside the warning window as soon', () => {
    const r = run({ 'gpt-5-mini': '2026-12-11' }, ['gpt-5-mini']);
    assert.deepEqual(r.soon.map((s) => s.id), ['gpt-5-mini']);
  });
});

describe('the repo registry against the live table shape', () => {
  it('every id in MODEL_SHUTDOWNS and ACCEPTED_SHUTDOWNS carries an ISO date', () => {
    for (const [id, d] of Object.entries({ ...ACCEPTED_SHUTDOWNS, ...MODEL_SHUTDOWNS })) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/, id);
    }
  });
  it('the 2026-12-11 gpt-5 family and o3 are registered (BRO-7339)', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'o3', 'o3-pro']) assert.equal(MODEL_SHUTDOWNS[id], '2026-12-11', id);
  });
});

describe('decideOpenAiRetirementAlerts', () => {
  it('an unreadable page files input-missing and never resolves the findings card', () => {
    const d = decideOpenAiRetirementAlerts({ inputMissing: true, missing: [], dateDrift: [] });
    assert.equal(d.length, 1);
    assert.equal(d[0].alert.conditionKey, INPUT_MISSING_KEY);
  });
  it('an unregistered model routes a card with model ids and dates only', () => {
    const d = decideOpenAiRetirementAlerts({ inputMissing: false, missing: [{ id: 'gpt-5-mini', shutdown: '2026-12-11', daysLeft: 30, replacement: 'gpt-5.6-terra' }], dateDrift: [] });
    assert.equal(d[0].action, 'resolve');
    assert.equal(d[0].conditionKey, INPUT_MISSING_KEY);
    assert.equal(d[1].action, 'route');
    assert.equal(d[1].alert.conditionKey, UNREGISTERED_KEY);
    assert.match(d[1].alert.description, /gpt-5-mini: OpenAI shuts it down 2026-12-11/);
  });
  it('a clean report resolves the findings card', () => {
    const d = decideOpenAiRetirementAlerts({ inputMissing: false, missing: [], dateDrift: [] });
    assert.deepEqual(d.map((x) => x.action), ['resolve', 'resolve']);
  });
});
