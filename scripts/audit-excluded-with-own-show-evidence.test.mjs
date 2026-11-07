import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./audit-excluded-with-own-show-evidence.js', import.meta.url));
const castText = 'Ann Lee and Bo Kim lead, with Cy Park.';

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-show-evidence-'));
  const dir = path.join(root, 'texts', 'demo-show');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  fs.writeFileSync(path.join(root, 'shows.json'), JSON.stringify([{ id: 'demo-show', title: 'Demo', cast: ['Ann Lee', 'Bo Kim', 'Cy Park'] }]));
  const r = spawnSync(process.execPath, [script, '--json', `--review-texts-dir=${path.join(root, 'texts')}`, `--shows-path=${path.join(root, 'shows.json')}`], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, out: r.status === 0 ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test('lists a flagged file whose body names the cast; skips unflagged, human-cleared and cast-less ones', () => {
  const { status, out } = run({
    'a.json': { wrongProduction: true, wrongProductionReason: 'CV-promoted: x', fullText: castText },
    'b.json': { wrongShow: true, fullText: castText },
    'c.json': { wrongProduction: true, wrongProductionManualClear: true, fullText: castText },
    'd.json': { fullText: castText },
    'e.json': { wrongProduction: true, fullText: 'A review that names nobody from the cast.' },
  });
  assert.equal(status, 0);
  assert.deepEqual(out.hits.map((h) => h.file).sort(), ['a.json', 'b.json']);
  assert.equal(out.hits[0].castListed, 3);
});

test('--gate fails above --max and an empty corpus never passes vacuously', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-show-evidence-'));
  fs.writeFileSync(path.join(root, 'shows.json'), JSON.stringify([{ id: 'x', cast: ['A B'] }]));
  fs.mkdirSync(path.join(root, 'texts'));
  const r = spawnSync(process.execPath, [script, '--gate', `--review-texts-dir=${path.join(root, 'texts')}`, `--shows-path=${path.join(root, 'shows.json')}`], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.status, 1);
});
