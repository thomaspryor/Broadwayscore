import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/enrich-west-end-dates.js');
const AUDIT = path.join(ROOT, 'data/audit/date-enrichment-corrections.json');
const SHOW = {
  id: 'audit-musical-west-end-2026', slug: 'audit-musical-west-end',
  title: 'Audit Musical', category: 'west-end', status: 'open',
  previewsStartDate: '2026-05-20', openingDate: '2026-05-28',
  openingDateSource: 'theatremonkey',
};

// Execute the real CLI and its real audit helper. Only external IO is replaced:
// fetch returns fixture HTML, shows writes go to a temp file, validation is
// stubbed, and the audit path is redirected away from the checkout's real log.
function runEnrichment(t, flags, { emptySources = false, show = SHOW, validationFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auditPath = path.join(dir, 'audit', 'runs.json');
  const savedPath = path.join(dir, 'saved-shows.json');
  const preload = path.join(dir, 'preload.cjs');
  const config = {
    script: SCRIPT, realAudit: AUDIT, auditPath, savedPath, validationFails,
    data: { _meta: {}, shows: [show] },
    pages: {
      'https://www.theatremonkey.com/shows/': emptySources
        ? '<html></html>' : '<a href="/show/audit-musical/">Audit Musical</a>',
      'https://www.theatremonkey.com/show/audit-musical/':
        'Showing from Wed, 20th May 2026. Press Night: 28th May 2026.',
      'https://playbill.com/article/schedule-of-upcoming-london-shows': '<html></html>',
    },
  };
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const config = ${JSON.stringify(config)};
    const scriptRequire = createRequire(config.script);
    const guardId = scriptRequire.resolve('./lib/shows-write-guard');
    require.cache[guardId] = { exports: {
      loadShows: () => config.data,
      saveShows: data => fs.writeFileSync(config.savedPath, JSON.stringify(data)),
    } };
    for (const method of ['readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync']) {
      const original = fs[method];
      fs[method] = (p, ...args) => original(
        p === config.realAudit ? config.auditPath
          : p === path.dirname(config.realAudit) ? path.dirname(config.auditPath) : p,
        ...args
      );
    }
    global.fetch = async url => {
      if (!Object.hasOwn(config.pages, url)) throw new Error('Unexpected fetch: ' + url);
      return { ok: true, text: async () => config.pages[url] };
    };
    require('node:child_process').execSync = () => {
      if (config.validationFails) throw new Error('Fixture validation failure');
    };
  `);
  const result = spawnSync(process.execPath, ['--require', preload, SCRIPT, '--skip-olt', ...flags], {
    cwd: ROOT, env: { ...process.env, GITHUB_OUTPUT: '' }, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, validationFails ? 1 : 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(auditPath), 'Every completed run must leave an audit row');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  assert.equal(audit._meta.schema, 'date-enrichment-corrections v1');
  assert.equal(audit.runs.length, 1, 'A live write must not be audited twice');
  const run = audit.runs[0];
  assert.equal(run.script, 'enrich-west-end-dates');
  assert.ok(Number.isFinite(Date.parse(run.runAt)));
  assert.deepEqual(run.mode, {
    dryRun: flags.includes('--dry-run'), verify: flags.includes('--verify'),
    force: false, fixUnconfirmed: false, showFilter: null,
  });
  const saved = fs.existsSync(savedPath) ? JSON.parse(fs.readFileSync(savedPath, 'utf8')) : null;
  return { run, saved, output: result.stdout };
}

for (const [mode, flags] of [['dry-run', ['--dry-run']], ['verify', ['--verify']], ['live', []]]) {
  test(`${mode}: matched shows with no corrections still leave an audit row`, t => {
    const { run, saved, output } = runEnrichment(t, flags);
    assert.deepEqual(run.entries, []);
    assert.equal(saved, null);
    assert.match(output, /Matched to shows: 1/);
  });

  test(`${mode}: empty source results still leave an audit row`, t => {
    const { run, saved, output } = runEnrichment(t, flags, { emptySources: true });
    assert.deepEqual(run.entries, []);
    assert.equal(saved, null);
    assert.match(output, /No changes to apply/);
  });

  test(`${mode}: corrections and audit-only discrepancies retain their details`, t => {
    const { run, saved } = runEnrichment(t, flags, {
      show: { ...SHOW, previewsStartDate: null, openingDate: '2026-05-29' },
    });
    assert.deepEqual(run.entries, [
      { kind: 'applied', show: SHOW.title, slug: SHOW.slug, id: SHOW.id,
        changes: [{ field: 'previewsStartDate', old: null, new: '2026-05-20' }] },
      { kind: 'discrepancy', show: SHOW.title, slug: SHOW.slug, id: SHOW.id,
        discrepancies: [{ field: 'openingDate', current: '2026-05-29', external: '2026-05-28', source: 'theatremonkey' }] },
    ]);
    if (mode === 'live') {
      assert.equal(saved.shows[0].previewsStartDate, '2026-05-20');
      assert.equal(saved.shows[0].openingDate, '2026-05-29');
    } else {
      assert.equal(saved, null);
    }
  });
}

test('a live write leaves its audit row even when subsequent validation fails', t => {
  const { run, saved } = runEnrichment(t, [], {
    show: { ...SHOW, previewsStartDate: null }, validationFails: true,
  });
  assert.equal(run.entries[0].kind, 'applied');
  assert.equal(saved.shows[0].previewsStartDate, '2026-05-20');
});
