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
