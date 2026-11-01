// BRO-6769: Live in HD wording helpers and expiry. Real src/lib/met-live-in-hd.ts is exercised via tsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = code => execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).trim();

test('liveInHd line, description and expiry', () => {
  const out = JSON.parse(run(`
    import('./src/lib/met-live-in-hd.ts').then(m => {
      const h = { date: '2026-10-03', encoreDate: '2026-10-14', sourceUrl: 'https://www.metopera.org/x' };
      console.log(JSON.stringify({
        line: m.liveInHdLine(h, '2026-09-01'),
        desc: m.liveInHdDescription('Cosi fan tutte', h, '2026-09-01'),
        afterLive: m.liveInHdLine(h, '2026-10-10'),
        afterEncore: m.liveInHdLine(h, '2026-10-15'),
        none: m.liveInHdLine(null),
      }));
    });`));
  assert.equal(out.line, 'In cinemas Oct 3, 2026 (encore Oct 14, 2026)');
  assert.equal(out.desc, 'Cosi fan tutte Met Live in HD cinema broadcast: Oct 3, 2026.');
  assert.ok(out.afterLive, 'encore still ahead keeps the line');
  assert.equal(out.afterEncore, null);
  assert.equal(out.none, null);
});
