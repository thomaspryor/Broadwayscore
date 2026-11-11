// BRO-7342: Anthropic and Gemini shutdown drift checks. Requires the real helpers (rule 15).
// Fixture rows copied from the live pages (2026-11-11): platform.claude.com model-deprecations
// (HTML tables) and ai.google.dev/gemini-api/docs/deprecations (Markdoc tables).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/provider-deprecations');
const { decideProviderRetirementAlerts } = require('../../scripts/lib/provider-retirement-alert');

const btn = (id) => `<button type="button" aria-label="Copy model ID ${id}" class="x">${id}</button>`;
const ANTHROPIC = `<table><thead><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr></thead><tbody>
<tr><td>${btn('claude-fable-5')}</td><td>Active</td><td>N/A</td><td>Not sooner than June 9, 2027</td></tr>
<tr><td>${btn('claude-mythos-preview')}</td><td>Deprecated</td><td>June 9, 2026</td><td>To be announced</td></tr>
<tr><td>${btn('claude-sonnet-4-5-20250929')}</td><td>Deprecated</td><td>May 1, 2026</td><td>November 30, 2026</td></tr>
</tbody></table>
<table><thead><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr></thead><tbody>
<tr><td>October 28, 2025</td><td>${btn('claude-3-5-sonnet-20241022')}</td><td>${btn('claude-sonnet-5-5')}</td></tr>
<tr><td>April 20, 2026</td><td>claude-3-haiku-20240307</td><td>claude-haiku-4-5-20251001</td></tr>
</tbody></table>
<table><thead><tr><th>Parameter</th><th>Status</th><th>Behavior</th><th>Recommended replacement</th></tr></thead><tbody>
<tr><td>temperature</td><td>Removed in API version 2026-10-21</td><td>400</td><td>Omit</td></tr></tbody></table>`;

const GEMINI = `## Gemini 3 models
{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement
  ---
  * \`gemini-3.8-flash\`
  * September 2, 2026
  * No shutdown date announced
  *
  ---
  * \`gemini-3.5-flash\`
  * May 19, 2026
  * N/A
  * \`gemini-3.6-flash\` (routes automatically)
{% /table %}
## Gemini 2.5 models
{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement
  ---
  * \`gemini-2.5-flash\`
  * June 17, 2025
  * December 1, 2026
  * \`gemini-3.5-flash-lite\`
  ---
  * \`gemini-2.5-pro\`
  * June 17, 2025
  * December 1, 2026
  * \`gemini-3.8-flash\`
{% /table %}`;

describe('Anthropic parser', () => {
  const rows = D.parseAnthropicDeprecations(ANTHROPIC);
  it('keeps dated retirements from both table styles and skips Active floors and TBA rows', () => {
    assert.deepEqual(rows.map((r) => [r.ids[0], r.shutdown]), [
      ['claude-sonnet-4-5-20250929', '2026-11-30'],
      ['claude-3-5-sonnet-20241022', '2025-10-28'],
      ['claude-3-haiku-20240307', '2026-04-20'],
    ]);
    assert.equal(rows[1].replacement, 'claude-sonnet-5-5');
  });
  it('counts the same rows as the denominator, and a shell page parses nothing', () => {
    assert.equal(D.countAnthropicModelRows(ANTHROPIC), 4, "the TBA row counts: it names a model but has no date");
    assert.equal(D.readProviderPage('anthropic', '<html>Just a moment...</html>').inputMissing, true);
  });
  it('folds dated snapshots to the alias and finds quoted ids', () => {
    assert.equal(D.anthropicBaseId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
    assert.deepEqual([...D.referencedAnthropicIds(`a='claude-3-5-haiku-20241022'; b="claude-sonnet-4-6"; c='gpt-5'`)].sort(), ['claude-3-5-haiku', 'claude-sonnet-4-6']);
  });
});

describe('Gemini parser', () => {
  const rows = D.parseGeminiDeprecations(GEMINI);
  it('reads the Shutdown date column by header and skips "No shutdown date announced" and N/A', () => {
    assert.deepEqual(rows, [
      { shutdown: '2026-12-01', ids: ['gemini-2.5-flash'], replacement: 'gemini-3.5-flash-lite' },
      { shutdown: '2026-12-01', ids: ['gemini-2.5-pro'], replacement: 'gemini-3.8-flash' },
    ]);
    assert.equal(D.countGeminiModelRows(GEMINI), 2);
  });
  it('finds quoted gemini ids', () => {
    assert.deepEqual([...D.referencedGeminiIds(`m='gemini-2.5-flash'; n="gemini-2.5-flash-lite-preview-09-2025"; o='claude-x1'`)].sort(), ['gemini-2.5-flash', 'gemini-2.5-flash-lite-preview-09-2025']);
  });
});

describe('drift through the shared driftReport', () => {
  const today = '2026-11-11';
  it('flags the unregistered Gemini pin with its countdown (the gemini-2.5-flash case)', () => {
    const r = D.driftReport({ page: D.parseGeminiDeprecations(GEMINI), registry: {}, referenced: ['gemini-2.5-flash', 'gemini-3.8-flash'], today, baseIdFn: D.geminiBaseId });
    assert.deepEqual(r.missing.map((m) => [m.id, m.daysLeft, m.replacement]), [['gemini-2.5-flash', 20, 'gemini-3.5-flash-lite']]);
    assert.deepEqual(r.soon.map((s) => s.id), ['gemini-2.5-flash']);
  });
  it('matches a pinned Anthropic snapshot to its page row through the alias, and goes quiet once registered', () => {
    const page = D.parseAnthropicDeprecations(ANTHROPIC);
    const referenced = D.referencedAnthropicIds(`'claude-sonnet-4-5-20250929'`);
    const r = D.driftReport({ page, registry: {}, referenced, today, baseIdFn: D.anthropicBaseId });
    assert.equal(r.missing[0].id, 'claude-sonnet-4-5');
    assert.equal(r.missing[0].shutdown, '2026-11-30');
    const quiet = D.driftReport({ page, registry: { 'claude-sonnet-4-5': '2026-11-30' }, referenced, today, baseIdFn: D.anthropicBaseId });
    assert.deepEqual([quiet.missing, quiet.dateDrift], [[], []]);
  });
});

describe('alert decisions', () => {
  it('an unreadable page files input-missing for that provider only', () => {
    const d = decideProviderRetirementAlerts('gemini', { inputMissing: true });
    assert.equal(d.length, 1);
    assert.equal(d[0].alert.conditionKey, 'gemini-retirement:input-missing');
  });
  it('findings route a card with ids and dates only; a clean report resolves it', () => {
    const d = decideProviderRetirementAlerts('anthropic', { inputMissing: false, dateDrift: [], missing: [{ id: 'claude-sonnet-4-5', shutdown: '2026-11-30', daysLeft: 19, replacement: null }] });
    assert.equal(d[1].alert.conditionKey, 'anthropic-retirement:unregistered');
    assert.match(d[1].alert.description, /claude-sonnet-4-5: Anthropic shuts it down 2026-11-30/);
    const clean = decideProviderRetirementAlerts('anthropic', { inputMissing: false, dateDrift: [], missing: [] });
    assert.deepEqual(clean.map((x) => x.action), ['resolve', 'resolve']);
  });
});

describe('CLI and workflow wiring (fails if either provider step is dropped)', () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const wf = fs.readFileSync(path.join(root, '.github/workflows/data-health-check.yml'), 'utf8');
  it('data-health-check runs the audit for both providers with --alert', () => {
    for (const p of ['anthropic', 'gemini']) assert.match(wf, new RegExp(`audit-provider-retirements\\.js --provider=${p} --strict --alert`));
  });
  it('--strict exits non-zero on a seeded unregistered shutdown, 0 on a clean registry', async () => {
    const { spawnSync } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname, 'pd-'));
    try {
      const f = path.join(tmp, 'gemini.md');
      // The CLI refuses a page with fewer rows than the provider minimum (input-missing), so pad past it.
      const pad = ['gemini-x-a', 'gemini-x-b'].map((id) => `  ---\n  * \`${id}\`\n  * May 1, 2025\n  * June 1, 2027\n  * \`gemini-3.8-flash\``).join('\n');
      fs.writeFileSync(f, GEMINI.replace('{% /table %}\n## Gemini 2.5', '{% /table %}\n## Gemini 2.5').replace(/\{% \/table %\}$/, `${pad}\n{% /table %}`) + '\n');
      // gemini-2.5-flash is referenced by repo code and unregistered in research-cost.js: seeded mismatch.
      const bad = spawnSync('node', ['scripts/audit-provider-retirements.js', '--provider=gemini', `--html=${f}`, '--strict'], { cwd: root, encoding: 'utf8' });
      assert.equal(bad.status, 1, bad.stdout + bad.stderr);
      assert.match(bad.stdout, /UNREGISTERED\s+gemini-2\.5-flash /);
      const none = spawnSync('node', ['scripts/audit-provider-retirements.js', '--provider=gemini', `--html=${f}`], { cwd: root, encoding: 'utf8' });
      assert.equal(none.status, 0, 'advisory without --strict');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
