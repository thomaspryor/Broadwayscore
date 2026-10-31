// Follow-up to card #91 ("Rage clicks on /best-value page, 3 occurrences") /
// tests/unit/best-value-rage-clicks.test.mjs. That fix gated BestValueTable's
// row hover behind hasMultiple; a /what-else sweep after shipping it found the
// exact same mismatch (unconditional hover:bg-white/5 on a <tr> whose onClick
// is gated behind hasDetails/hasMultiple) copy-pasted into two more shared
// table components used by /discount-tickets, /lotteries, and /rush:
//   - src/app/discount-tickets/DiscountTicketsTable.tsx (hasDetails)
//   - src/components/SortableLotteryRushTables.tsx (three tables, hasDetails)
// Same fix: hover:bg-white/5 moves inside the hasDetails-gated branch so only
// rows that actually respond to a click look clickable.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function assertNoUnconditionalHoverRow(filePath, occurrences = 1) {
  const src = readFileSync(join(ROOT, filePath), 'utf8');
  assert.doesNotMatch(
    src,
    /className=\{`border-b border-white\/5 hover:bg-white\/5 transition-colors \$\{hasDetails/,
    `${filePath}: hover:bg-white/5 must not be unconditional on a row whose onClick is gated on hasDetails`,
  );
  const matches = src.match(/hasDetails \? 'cursor-pointer hover:bg-white\/5' : ''/g) || [];
  assert.equal(
    matches.length,
    occurrences,
    `${filePath}: expected ${occurrences} row(s) gating hover behind hasDetails, found ${matches.length}`,
  );
}

describe('discount-ticket table rows only look clickable when they actually are (cousins of card #91)', () => {
  test('/discount-tickets DiscountTicketsTable.tsx gates hover on hasDetails', () => {
    assertNoUnconditionalHoverRow('src/app/discount-tickets/DiscountTicketsTable.tsx', 1);
  });

  test('SortableLotteryRushTables.tsx gates hover on hasDetails in all three tables (lottery, SRO, rush)', () => {
    assertNoUnconditionalHoverRow('src/components/SortableLotteryRushTables.tsx', 3);
  });
});
