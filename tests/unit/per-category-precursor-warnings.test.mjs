/**
 * Tests for the warning threshold + error-class distinction in
 * scripts/lib/per-category-precursor.js runCategoryScraper.
 *
 * The function is I/O-bound (fetches Wikipedia + reads/writes JSON) so we
 * stub the I/O dependencies. The behavior under test is:
 *   - Single retired category (0 entries vs ≥5 baseline) → soft-continue
 *   - 3+ structural warnings → threshold hit, throw
 *   - 2 warnings on 8-page ceremony does NOT throw (below absolute-3 floor)
 *   - Parser exception → ::error:: + warning recorded
 *   - Network exception → ::warning:: + soft-continue
 *   - 404/410 → silent skip (not counted as warning)
 *
 * Tests the actual exported function with mocked dependencies via require cache
 * injection.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PRECURSOR_LIB = path.join(__dirname, '..', '..', 'scripts', 'lib', 'per-category-precursor.js');

function makeTempBaseline(ceremonyName, baselineByCategory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'percat-test-'));
  const fp = path.join(dir, `${ceremonyName}.json`);
  fs.writeFileSync(fp, JSON.stringify({ data: baselineByCategory }));
  return { dir, fp };
}

// Helper to drive runCategoryScraper with mocked deps via require cache.
function makeRunner({ pageResponses, baselineData }) {
  delete require.cache[require.resolve('../../scripts/lib/precursor-category-parser.js')];
  delete require.cache[require.resolve('../../scripts/lib/precursor-wikipedia.js')];
  delete require.cache[require.resolve(PRECURSOR_LIB)];

  const tmp = makeTempBaseline('test-ceremony', baselineData || {});

  require.cache[require.resolve('../../scripts/lib/precursor-category-parser.js')] = {
    id: 'parser',
    filename: 'parser',
    loaded: true,
    exports: {
      fetchHtml: async (url) => {
        const slug = url.split('/').pop();
        const response = pageResponses[slug];
        if (response instanceof Error) throw response;
        return response;
      },
      parseCategoryPage: (html, opts) => {
        // Encoding convention: html is a JSON string of {entries, throws}
        const parsed = JSON.parse(html);
        if (parsed.throws) {
          const e = new Error(parsed.throws);
          e.name = parsed.errorName || 'Error';
          throw e;
        }
        return parsed.entries || [];
      },
    },
  };

  require.cache[require.resolve('../../scripts/lib/precursor-wikipedia.js')] = {
    id: 'wiki',
    filename: 'wiki',
    loaded: true,
    exports: {
      writePrecursorJson: (name, data, opts) => ({ fp: tmp.fp, written: !opts.dryRun, newCount: 0, oldCount: 0 }),
      sleep: () => Promise.resolve(),
      RATE_LIMIT_MS: 0,
      PRECURSORS_DIR: tmp.dir,
    },
  };

  return require(PRECURSOR_LIB);
}

describe('runCategoryScraper warning threshold', () => {
  it('single retired category passes (1 warning < absolute-3 floor)', async () => {
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': JSON.stringify({ entries: [{ year: 2025, winner: 'X', nominees: [] }] }),
        'Cat_B': JSON.stringify({ entries: [{ year: 2025, winner: 'Y', nominees: [] }] }),
        'Cat_C': JSON.stringify({ entries: [{ year: 2025, winner: 'Z', nominees: [] }] }),
        'Cat_D_retired': JSON.stringify({ entries: [] }),
      },
      baselineData: {
        'Cat A': [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }],
        'Cat B': [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }],
        'Cat C': [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }],
        'Cat D retired': [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }],
      },
    });

    await assert.doesNotReject(
      runCategoryScraper({
        pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D retired': 'Cat_D_retired' },
        ceremonyName: 'test-ceremony',
        minYear: 2014,
        write: false,
        force: false,
      })
    );
  });

  it('3+ structural warnings throws (threshold = 3 absolute)', async () => {
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': JSON.stringify({ entries: [] }),
        'Cat_B': JSON.stringify({ entries: [] }),
        'Cat_C': JSON.stringify({ entries: [] }),
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_E': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: {
        'Cat A': baselineEntries,
        'Cat B': baselineEntries,
        'Cat C': baselineEntries,
        'Cat D': baselineEntries,
        'Cat E': baselineEntries,
      },
    });

    await assert.rejects(
      runCategoryScraper({
        pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D', 'Cat E': 'Cat_E' },
        ceremonyName: 'test-ceremony',
        minYear: 2014,
        write: false,
        force: false,
      }),
      /Warning threshold exceeded/
    );
  });

  it('2 warnings on a large ceremony passes (below absolute-3 threshold)', async () => {
    // Threshold is absolute count ≥3. 2 of 8 (25%) does NOT trip.
    // Chosen because typical ceremonies have 25-40 pages where absolute is the
    // right gate. Smaller ceremonies (5-8 pages) will gate slightly earlier on
    // a percentage basis but that's acceptable — better to early-warn than miss.
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const pages = {};
    const baseline = {};
    const responses = {};
    for (let i = 0; i < 8; i++) {
      const slug = `Cat_${i}`;
      const name = `Cat ${i}`;
      pages[name] = slug;
      baseline[name] = baselineEntries;
      responses[slug] = JSON.stringify({ entries: i < 2 ? [] : [{ year: 2025 }] });
    }
    const { runCategoryScraper } = makeRunner({ pageResponses: responses, baselineData: baseline });
    await assert.doesNotReject(
      runCategoryScraper({ pages, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false })
    );
  });

  it('parser TypeError is recorded as warning and counts toward threshold', async () => {
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': JSON.stringify({ throws: 'Cannot read properties of undefined', errorName: 'TypeError' }),
        'Cat_B': JSON.stringify({ throws: 'Cannot read properties of undefined', errorName: 'TypeError' }),
        'Cat_C': JSON.stringify({ throws: 'Cannot read properties of undefined', errorName: 'TypeError' }),
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: { 'Cat A': baselineEntries, 'Cat B': baselineEntries, 'Cat C': baselineEntries, 'Cat D': baselineEntries },
    });
    await assert.rejects(
      runCategoryScraper({ pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D' }, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false }),
      /Warning threshold exceeded/
    );
  });

  it('404/410 errors are silent skips (NOT counted as warnings)', async () => {
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const e404 = new Error('HTTP 404 not found');
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': e404,
        'Cat_B': e404,
        'Cat_C': e404,
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: { 'Cat A': baselineEntries, 'Cat B': baselineEntries, 'Cat C': baselineEntries, 'Cat D': baselineEntries },
    });
    // 3 404s would normally trip threshold — but 404s are excluded.
    await assert.doesNotReject(
      runCategoryScraper({ pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D' }, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false })
    );
  });

  it('unknown error class still counted as warning + soft-continues', async () => {
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': new Error('some weird unexpected failure mode'), // neither parse nor network regex matches
        'Cat_B': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_C': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: { 'Cat A': baselineEntries, 'Cat B': baselineEntries, 'Cat C': baselineEntries, 'Cat D': baselineEntries },
    });
    // 1 unknown warning of 4 = below absolute-3 → soft-continue.
    await assert.doesNotReject(
      runCategoryScraper({ pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D' }, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false })
    );
  });

  it('warningThreshold override raises floor for small ceremonies', async () => {
    // 3 warnings on a 5-page ceremony — would normally trip default threshold=3.
    // With threshold=5, should pass.
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': JSON.stringify({ entries: [] }),
        'Cat_B': JSON.stringify({ entries: [] }),
        'Cat_C': JSON.stringify({ entries: [] }),
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_E': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: { 'Cat A': baselineEntries, 'Cat B': baselineEntries, 'Cat C': baselineEntries, 'Cat D': baselineEntries, 'Cat E': baselineEntries },
    });
    await assert.doesNotReject(
      runCategoryScraper({ pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D', 'Cat E': 'Cat_E' }, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false, warningThreshold: 5 })
    );
  });

  it('network errors are warnings (counted toward threshold) — soft-continue at low counts', async () => {
    const baselineEntries = [{ year: 2020 }, { year: 2021 }, { year: 2022 }, { year: 2023 }, { year: 2024 }];
    const { runCategoryScraper } = makeRunner({
      pageResponses: {
        'Cat_A': new Error('ETIMEDOUT'),
        'Cat_B': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_C': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_D': JSON.stringify({ entries: [{ year: 2025 }] }),
        'Cat_E': JSON.stringify({ entries: [{ year: 2025 }] }),
      },
      baselineData: { 'Cat A': baselineEntries, 'Cat B': baselineEntries, 'Cat C': baselineEntries, 'Cat D': baselineEntries, 'Cat E': baselineEntries },
    });
    // 1 warning of 5 = 20% — below 25% threshold AND below 3 — should pass.
    await assert.doesNotReject(
      runCategoryScraper({ pages: { 'Cat A': 'Cat_A', 'Cat B': 'Cat_B', 'Cat C': 'Cat_C', 'Cat D': 'Cat_D', 'Cat E': 'Cat_E' }, ceremonyName: 'test-ceremony', minYear: 2014, write: false, force: false })
    );
  });
});
