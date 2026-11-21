import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

for (const hook of ['pre-push-review-gate.sh', 'pre-merge-review-gate.sh']) {
  // Source the real writer without executing the gate's unrelated git checks.
  const source = readFileSync(path.join(root, '.claude/hooks', hook), 'utf8');
  const writer = source.match(/^log_bypass\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(writer, `${hook} defines log_bypass`);

  for (const initialLines of [0, 3, 4999, 5000, 5001, 12000]) {
    test(`${hook}: ${initialLines} existing lines`, (t) => {
      const home = mkdtempSync(path.join(root, '.finish-line-log-trim-'));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const logFile = path.join(home, '.claude/logs/finish-line-bypass.log');
      const original = Array.from({ length: initialLines }, (_, i) => `existing-${i}\n`).join('');
      if (initialLines) {
        mkdirSync(path.dirname(logFile), { recursive: true });
        writeFileSync(logFile, original);
      }

      const result = spawnSync('bash', ['-c', `${writer}\ntranscript=fixture-transcript\nlog_bypass TEST fixture-reason`], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '', 'missing logs must not cause shell redirect errors');
      const log = readFileSync(logFile, 'utf8');
      const entry = log.slice(log.lastIndexOf('\n', log.length - 2) + 1);
      assert.match(entry, /^\d+\tTEST\tfixture-transcript\tfixture-reason\n$/);
      const retained = log.slice(0, -entry.length);
      if (initialLines + 1 > 5000) {
        assert.equal(log.split('\n').length - 1, 2000);
        assert.equal(retained, original.split('\n').slice(-2000).join('\n'), 'retain the newest 1999 existing rows');
      } else {
        assert.equal(retained, original, 'preserve every existing byte below the trim threshold');
        assert.equal(log.split('\n').length - 1, initialLines + 1);
      }
    });
  }
}
