// purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Rule (af), BRO-8383: `npx supabase` must name an exact CLI version. Unpinned,
 * it floated to supabase@3.4.0, which refuses hosted changes without --yes,
 * and every edge-function deploy failed (run 45961348571). Pattern: require()
 * the real function (CLAUDE.md rule 15); the last test sweeps the real workflows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findUnpinnedSupabaseCli } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.resolve(import.meta.dirname, '../..');

describe('findUnpinnedSupabaseCli', () => {
  test('flags bare, -y, @latest, major-only and range forms', () => {
    const raw = [
      '        run: npx supabase secrets set X=1',
      '          npx -y supabase functions deploy f',
      '          npx --yes supabase@latest db push',
      '          npx supabase@3 functions deploy f',
      '          npx supabase@^3.4.0 functions deploy f',
      '          bunx supabase db push',
      '          pnpm dlx supabase db push',
      '          npm exec supabase -- db push',
    ].join('\n');
    assert.deepEqual(findUnpinnedSupabaseCli(raw).map((h) => h.lineNum), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('accepts an exact version and ignores comments', () => {
    const raw = [
      '          npx supabase@3.4.0 functions deploy f --yes',
      '          npx -y supabase@2.122.1 secrets list',
      '        # unpinned `npx supabase` floated to 3.4.0',
      '          echo ok # npx supabase in a trailing comment',
    ].join('\n');
    assert.equal(findUnpinnedSupabaseCli(raw).length, 0);
  });
  test('the real workflows pin every npx supabase call', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (raw.includes('hygiene-supabase-cli-ok:')) continue;
      for (const h of findUnpinnedSupabaseCli(raw)) bad.push(`${f}:${h.lineNum} ${h.text}`);
    }
    assert.deepEqual(bad, []);
  });
});
