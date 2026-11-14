/**
 * ISR regression guard (BRO-1212).
 *
 * Full static export (`output: 'export'`) forces every one of the site's
 * 700+ show pages to rebuild on every deploy — the original problem this
 * card fixed (13-15 min builds, growing linearly with show count). The fix
 * (commits 9d71074795e, 3c289fa9a5c) removed `output: 'export'` from
 * next.config.js and switched `/show/[slug]` to ISR: `generateStaticParams()`
 * pre-renders only the high-traffic subset (open/previews/recently-closed),
 * everything else is generated on-demand and cached at the edge per
 * `revalidate`. Re-adding `output: 'export'`, or dropping `revalidate` /
 * `generateStaticParams` from the show page, silently regresses back to a
 * full rebuild on every deploy with no visible error — this guard would be
 * the only thing to catch that.
 *
 * Run: node --test tests/unit/isr-config.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

describe('next.config.js does not force full static export', () => {
  const config = readFileSync(join(root, 'next.config.js'), 'utf8');

  test('no output: \'export\' anywhere in the config', () => {
    assert.ok(!/output\s*:\s*['"]export['"]/.test(config),
      'next.config.js sets output: \'export\' — this forces a full static export ' +
      'of every show page on every deploy (the exact problem BRO-1212 fixed). ' +
      'ISR requires Vercel serverless functions and is incompatible with static export.');
  });
});

describe('/show/[slug] uses ISR, not full pre-render', () => {
  const pagePath = join(root, 'src/app/show/[slug]/page.tsx');
  const page = readFileSync(pagePath, 'utf8');

  test('exports a numeric revalidate', () => {
    const match = page.match(/export const revalidate\s*=\s*(\d+)/);
    assert.ok(match,
      'src/app/show/[slug]/page.tsx has no `export const revalidate = <n>` — without it, ' +
      'the page is either fully static (export) or revalidates on every request, neither of ' +
      'which is ISR.');
    assert.ok(Number(match[1]) > 0, 'revalidate must be a positive number of seconds');
  });

  test('generateStaticParams pre-renders a subset, not every show', () => {
    assert.ok(/export (async )?function generateStaticParams/.test(page),
      'src/app/show/[slug]/page.tsx has no generateStaticParams — without it Next.js cannot ' +
      'determine which paths to pre-render, which for a dynamic route under ISR either pre-renders ' +
      'nothing or (under static export) requires every path to be enumerated and built upfront.');
    assert.ok(/getRecentShowSlugs\(\)/.test(page),
      'generateStaticParams should source from getRecentShowSlugs() (open/previews/recently-closed) ' +
      'rather than every show — enumerating all shows here defeats ISR by forcing a full build again.');
  });
});
