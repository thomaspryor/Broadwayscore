import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('bulk pending apply cannot recreate an orphan, while live IDs resolve to slugs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-pending-identity-'));
  try {
    const pending = { shows: {
      '860': { slug: '860', designation: 'TBD', confidence: 'high' },
      'hamilton-2015': { slug: 'hamilton-2015', designation: 'TBD', confidence: 'high' },
    } };
    const shows = { shows: [{ id: 'hamilton-2015', slug: 'hamilton', category: 'broadway', status: 'open' }] };
    const commercial = { _meta: {}, shows: {} };
    for (const [name, value] of Object.entries({ pending, shows, commercial })) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
    }
    const args = ['scripts/apply-commercial-pending.js', '--dry-run', '--no-source-verify',
      `--pending-file=${dir}/pending.json`, `--shows-file=${dir}/shows.json`, `--commercial-file=${dir}/commercial.json`];
    const output = execFileSync(process.execPath, [...args, '--all'], { encoding: 'utf8' });
    assert.match(output, /Skipping "860": no show resolves/);
    assert.doesNotMatch(output, /Would apply "860"/);
    assert.match(output, /Would apply "hamilton-2015"/);
    assert.match(output, /would apply 1, skip 1/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))), pending, 'orphan stays available for review');

    const manual = execFileSync(process.execPath, [...args, '--show=860'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(manual, /Would apply "860"/, 'explicit manual enrollment still works before the shows-list update');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary bulk and single-show apply hold invalid win records before publication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-pending-validation-'));
  try {
    const pending = { shows: {
      'unknown-outcome': { designation: 'TBD', confidence: 'high' },
      'win-without-recoupment': { designation: 'Easy Winner', recouped: null, confidence: 'high' },
      'win-with-loss': { designation: 'Miracle', recouped: false, confidence: 'high' },
    } };
    const shows = { shows: Object.keys(pending.shows).map(id => ({
      id, slug: id, category: 'broadway', status: 'open', openingDate: '2026-01-01',
    })) };
    const commercial = { _meta: {}, shows: {
      'win-without-recoupment': { designation: 'TBD', recouped: null },
    } };
    for (const [name, value] of Object.entries({ pending, shows, commercial })) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
    }
    const args = ['scripts/apply-commercial-pending.js', '--dry-run', '--no-source-verify',
      `--pending-file=${dir}/pending.json`, `--shows-file=${dir}/shows.json`, `--commercial-file=${dir}/commercial.json`];
    const bulk = execFileSync(process.execPath, [...args, '--all'], { encoding: 'utf8' });
    assert.match(bulk, /Would apply "unknown-outcome"/);
    for (const id of ['win-without-recoupment', 'win-with-loss']) {
      assert.doesNotMatch(bulk, new RegExp(`Would apply "${id}"`));
      assert.match(bulk, new RegExp(`"${id}".*left pending for review:.*recouped=`));
      const single = execFileSync(process.execPath, [...args, `--show=${id}`], { encoding: 'utf8' });
      assert.doesNotMatch(single, /Would apply/);
      assert.match(single, /would apply 0, skip 1/);
    }
    assert.match(bulk, /would apply 1, skip 2/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))), pending);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'commercial.json'))), commercial);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
