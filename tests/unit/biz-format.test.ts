/**
 * Unit tests for the shared /biz currency formatter (task #158, P0-1).
 * Null capitalization used to render "~$0" (Ragtime, Dorian Gray) because
 * every component reimplemented its own formatter with an inconsistent null
 * path. formatCurrency itself is the app-wide @/lib/formatting helper
 * (re-exported here) — this only locks the /biz-specific "~" wrapper and
 * the null contract this file promises.
 *
 * BRO-4623: formatCapitalSummary (P0-6, capital totals never read "~$0") and
 * formatDataDate (P1-1, the /biz freshness line). formatCapitalization: every
 * capitalization used to print "~" (formatEstimatedCurrency), so a cited
 * figure read as our guess; now only an isEstimate-flagged one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatCapitalization,
  formatCapitalSummary,
  formatDataDate,
  formatDevelopmentDate,
  sortNewestFirst,
} from '../../src/lib/biz-format';
import { isEstimatedCapitalization, isMaximumCapitalization, toPublicShowCommercial, sourceTextSegments, sourceTextLink } from '../../src/lib/commercial-display';
import type { ShowCommercial } from '../../src/lib/data-types';

test('formatCurrency: null/undefined render em-dash, never $0', () => {
  assert.equal(formatCurrency(null), '—');
  assert.equal(formatCurrency(undefined), '—');
});

test('formatCurrency: zero is a real reportable value, not missing data', () => {
  assert.equal(formatCurrency(0), '$0');
});

test('formatCurrency: scales K/M/B', () => {
  assert.equal(formatCurrency(850_000), '$850K');
  assert.equal(formatCurrency(12_500_000), '$12.5M');
  assert.equal(formatCurrency(1_400_000_000), '$1.4B');
});

test('formatCapitalization: null renders bare em-dash, never "~—", flagged or not', () => {
  assert.equal(formatCapitalization(null, false, false), '—');
  assert.equal(formatCapitalization(undefined, false, false), '—');
  assert.equal(formatCapitalization(null, true, false), '—');
  assert.equal(formatCapitalization(undefined, true, false), '—');
});

test('formatCapitalization: a reported figure prints plain, no "~"', () => {
  assert.equal(formatCapitalization(12_500_000, false, false), '$12.5M');
  assert.equal(formatCapitalization(850_000, false, false), '$850K');
});

test('formatCapitalization: only an estimate-flagged figure gets the "~" mark', () => {
  assert.equal(formatCapitalization(24_000_000, true, false), '~$24.0M');
});

const CITED = 'The New York Times, 2024-03-12';

test('isEstimatedCapitalization: a cited figure is reported unless the record flags it', () => {
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: {} }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { capitalization: false } }), false);
  // Another field's estimate flag does not mark the capitalization.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { weeklyRunningCost: true } }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { capitalization: true } }), true);
});

test('isEstimatedCapitalization: a source that says it is an estimate prints "~" (BRO-5517, Plaza Suite)', () => {
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Estimate: $2,000,887 NYC theatrical tax credit to Suite 719 LLC at the 25% credit rate' }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Estimated from the tax credit, https://example.com/a' }), true);
  // The short markers, written the usual way (a "$" or a space after them).
  assert.equal(isEstimatedCapitalization({ capitalizationSource: '~$8M per Variety, https://example.com/a' }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Est. $5M per Variety, https://example.com/a' }), true);
  // A rounded reported figure is still reported.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'About $12M per the SEC filing, https://www.sec.gov/x' }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Approximately $5M per SEC Form D, https://www.sec.gov/x' }), false);
  // A reported figure that merely mentions an estimate elsewhere stays reported.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED }), false);
});

test('isEstimatedCapitalization: an uncited figure reads as an estimate (BRO-4666)', () => {
  // JSON records can omit the field entirely.
  assert.equal(isEstimatedCapitalization({} as { capitalizationSource: null }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: null }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: '   ' }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: null, isEstimate: { capitalization: false } }), true);
  // Source text that is only internal research wording is not a citation.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Deep research synthesis' }), true);
});

test('show page (public record) and /biz (raw record) agree on the "~" mark', () => {
  const records = [
    { capitalization: 24_000_000, capitalizationSource: CITED },
    { capitalization: 24_000_000, capitalizationSource: null },
    { capitalization: 24_000_000, capitalizationSource: 'Deep research synthesis' },
    { capitalization: 24_000_000, capitalizationSource: CITED, isEstimate: { capitalization: true } },
  ] as ShowCommercial[];
  for (const raw of records) {
    assert.equal(isEstimatedCapitalization(toPublicShowCommercial(raw)), isEstimatedCapitalization(raw));
  }
});

test('cited vs flagged vs uncited records end to end', () => {
  const cited = { capitalizationSource: CITED, isEstimate: { weeklyRunningCost: true } };
  const flagged = { capitalizationSource: CITED, isEstimate: { capitalization: true } };
  const uncited = { capitalizationSource: null };
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(cited), false), '$24.0M');
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(flagged), false), '~$24.0M');
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(uncited), false), '~$24.0M');
});

// ── BRO-4623 P0-6 ──────────────────────────────────────────────────────────

test('formatCapitalSummary: no shows counted reads "None"', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 0, showCount: 0, undisclosedCount: 0 }), {
    value: 'None',
    note: null,
  });
});

test('formatCapitalSummary: shows counted but no figure known reads "Undisclosed", never "~$0"', () => {
  const out = formatCapitalSummary({ knownTotal: 0, showCount: 3, undisclosedCount: 3 });
  assert.equal(out.value, 'Undisclosed');
  assert.equal(out.note, '3 shows, capitalization not public');
  assert.doesNotMatch(out.value, /\$0/);
  assert.equal(
    formatCapitalSummary({ knownTotal: 0, showCount: 1, undisclosedCount: 1 }).note,
    '1 show, capitalization not public',
  );
});

test('formatCapitalSummary: a partial total gets "+" and says how many are missing', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 42_000_000, showCount: 9, undisclosedCount: 3 }), {
    value: '~$42M+',
    note: '3 of 9 undisclosed',
  });
});

test('formatCapitalSummary: a complete total has no "+" and no note', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 42_000_000, showCount: 9, undisclosedCount: 0 }), {
    value: '~$42M',
    note: null,
  });
});

// ── BRO-4623 P1-1 ──────────────────────────────────────────────────────────

test('formatDataDate: grosses "M/D/YYYY", ISO day and ISO timestamp', () => {
  assert.equal(formatDataDate('9/13/2026'), 'Sep 13, 2026');
  assert.equal(formatDataDate('2026-09-26'), 'Sep 26, 2026');
  // Parsed by hand: a late-UTC timestamp must not slip a day in any time zone.
  assert.equal(formatDataDate('2026-10-03T23:30:00Z'), 'Oct 3, 2026');
});

test('formatDataDate: missing or unparseable is null', () => {
  assert.equal(formatDataDate(null), null);
  assert.equal(formatDataDate(undefined), null);
  assert.equal(formatDataDate(''), null);
  assert.equal(formatDataDate('last week'), null);
  assert.equal(formatDataDate('2026-13-01'), null);
});

test('formatDevelopmentDate: every Recent Developments row carries its year', () => {
  // Recoupments (month precision) and closings (day precision) read alike,
  // so "Sep 20" can never sit next to "May 2026" and read as 2020.
  assert.equal(formatDevelopmentDate('2026-05'), 'May 2026');
  assert.equal(formatDevelopmentDate('2026-09-20'), 'Sep 2026');
  assert.equal(formatDevelopmentDate('2025-12-31'), 'Dec 2025');
  // Year-only recoupment dates and anything else pass through.
  assert.equal(formatDevelopmentDate('2026'), '2026');
  assert.equal(formatDevelopmentDate('2026-13'), '2026-13');
  assert.equal(formatDevelopmentDate('Now'), 'Now');
});

test('sortNewestFirst: recoupments and closings interleave by date, newest first', () => {
  // The live /biz list printed Jun, May, May, May recoupments and then a
  // Sep closing, because rows were grouped by type.
  const rows = [
    { id: 'purpose', date: '2026-06' },
    { id: 'just-in-time', date: '2026-05' },
    { id: 'giant', date: '2026-05' },
    { id: 'titanique', date: '2026-09-14' },
    { id: 'old-year-only', date: '2025' },
  ];
  const sorted = sortNewestFirst(rows, (r) => r.date).map((r) => r.id);
  assert.deepEqual(sorted, ['titanique', 'purpose', 'just-in-time', 'giant', 'old-year-only']);
  // Equal dates keep input order, and the input is not mutated.
  assert.equal(rows[0].id, 'purpose');
  // A day-precision date in the same month sorts above the month-only one.
  assert.deepEqual(
    sortNewestFirst([{ d: '2026-06' }, { d: '2026-06-15' }], (r) => r.d).map((r) => r.d),
    ['2026-06-15', '2026-06'],
  );
  // A year-only recoupment sorts below every month of that year and above
  // the year before (the old date-based sort read "2026" as Jan 1).
  assert.deepEqual(
    sortNewestFirst([{ d: '2025-12' }, { d: '2026' }, { d: '2026-01' }], (r) => r.d).map((r) => r.d),
    ['2026-01', '2026', '2025-12'],
  );
});

test('sourceTextSegments: a cited URL becomes a link labelled by its host (BRO-5520)', () => {
  const formD = 'https://www.sec.gov/Archives/edgar/data/2153516/000215351626000001/xslFormDX01/primary_doc.xml';
  assert.deepEqual(sourceTextSegments(`SEC Form D (Paranormal Broadway Ltd Liability Co): total offering $8,000,000 ${formD}`), [
    { kind: 'text', text: 'SEC Form D (Paranormal Broadway Ltd Liability Co): total offering $8,000,000 ' },
    { kind: 'link', href: formD, label: 'sec.gov' },
  ]);
  // A full stop after the URL stays text; two URLs; a source with none.
  assert.deepEqual(sourceTextSegments('See https://playbill.com/article/x. Also https://www.broadwayjournal.com/p/y'), [
    { kind: 'text', text: 'See ' },
    { kind: 'link', href: 'https://playbill.com/article/x', label: 'playbill.com' },
    { kind: 'text', text: '. Also ' },
    { kind: 'link', href: 'https://www.broadwayjournal.com/p/y', label: 'broadwayjournal.com' },
  ]);
  assert.deepEqual(sourceTextSegments('Hollywood Reporter (Nov 29, 2011)'), [{ kind: 'text', text: 'Hollywood Reporter (Nov 29, 2011)' }]);
  // Only http(s) URLs become links.
  assert.deepEqual(sourceTextSegments('javascript:alert(1) ftp://x.y'), [{ kind: 'text', text: 'javascript:alert(1) ftp://x.y' }]);
});

test('sourceTextLink: one link, no raw URL text, the quoted URL wins over the fallback (BRO-5520)', () => {
  const quoted = 'Broadway News (Mar 23, 2023): "made back its investment in December of 2022." https://www.broadwaynews.com/broadways-six-recoups/';
  assert.deepEqual(sourceTextLink(quoted, 'https://www.broadwayworld.com/x'), {
    label: 'Broadway News (Mar 23, 2023): "made back its investment in December of 2022."',
    href: 'https://www.broadwaynews.com/broadways-six-recoups/',
  });
  assert.deepEqual(sourceTextLink('Hollywood Reporter (Nov 29, 2011)', 'https://www.hollywoodreporter.com/a'), { label: 'Hollywood Reporter (Nov 29, 2011)', href: 'https://www.hollywoodreporter.com/a' });
  assert.deepEqual(sourceTextLink('Trade press report', null), { label: 'Trade press report', href: null });
  // A bare URL keeps a readable label.
  assert.deepEqual(sourceTextLink('https://www.sec.gov/x', null), { label: 'sec.gov', href: 'https://www.sec.gov/x' });
  // Two cited URLs (oh-mary): the first is the link, and the "Also:" left behind is dropped.
  const twoUrls = 'Playbill (Nov 25, 2024): "has officially recouped its production costs on Broadway" https://playbill.com/article/oh-mary-is-broadway-seasons-1st-show-to-recoup Also: https://deadline.com/2024/11/oh-mary-broadway-recoups-1236186683/';
  assert.deepEqual(sourceTextLink(twoUrls, null), {
    label: 'Playbill (Nov 25, 2024): "has officially recouped its production costs on Broadway"',
    href: 'https://playbill.com/article/oh-mary-is-broadway-seasons-1st-show-to-recoup',
  });
  // A URL in parentheses leaves no empty "()".
  assert.deepEqual(sourceTextLink('Variety (https://variety.com/a)', null), { label: 'Variety', href: 'https://variety.com/a' });
});

// ── BRO-5660 ───────────────────────────────────────────────────────────────
// A Form D offering maximum or an "up to" source printed as an exact
// capitalization (Cats: The Jellicle Ball "$18.0M" from "capitalized for up to
// $18 million"). A ceiling now prints "up to $X", in place of any "~".

test('formatCapitalization: a maximum prints "up to", never bare or with "~"', () => {
  assert.equal(formatCapitalization(18_000_000, false, true), 'up to $18.0M');
  assert.equal(formatCapitalization(18_000_000, true, true), 'up to $18.0M');
  assert.equal(formatCapitalization(null, true, true), '—');
});

test('isMaximumCapitalization: explicit basis wins, else the source wording', () => {
  const THR = 'The Hollywood Reporter (Jul 13, 2026): "The musical was capitalized for up to $18 million"';
  const FORM_D = 'SEC Form D filing (X LLC, filed May 30, 2024): total offering amount $5,500,000 ($400,000 sold by then).';
  const SOLD = 'SEC Form D/A filing (X LLC): total offering amount $10,000,000, fully sold.';
  const SOLD_OF = 'SEC Form D/A (X LLC): $20,000,000 sold of a $23,000,000 offering';
  const RANGE = 'SEC Form D/A filing (X LLC). $19M capitalized. Range: $17.5M min, $19.5M max.';
  const cap = 18_000_000;
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: THR }), true);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: FORM_D }), true);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: SOLD }), false);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: SOLD_OF }), false);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: RANGE }), false);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: CITED }), false);
  // A person's ruling beats the wording either way.
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: THR, capitalizationBasis: 'reported' }), false);
  assert.equal(isMaximumCapitalization({ capitalization: cap, capitalizationSource: RANGE, capitalizationBasis: 'maximum' }), true);
  assert.equal(isMaximumCapitalization({ capitalization: null, capitalizationSource: THR }), false);
});

test('toPublicShowCommercial keeps capitalizationBasis, so the card prints "up to"', () => {
  const raw = { capitalization: 7_000_000, capitalizationSource: CITED, capitalizationBasis: 'maximum' } as ShowCommercial;
  assert.equal(isMaximumCapitalization(toPublicShowCommercial(raw)), true);
});
