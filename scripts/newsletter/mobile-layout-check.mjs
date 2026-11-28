// Multi-width mobile layout gate for the weekly newsletter.
//
// Why (owner, 2026-11-15, small iPhone): the old gate (overflow-check.mjs) only
// rendered ONE width (375px) and only asked "is the page wider than the
// screen?". A card whose info column was squeezed to ~90px (pill wrapped to
// three lines, title to four, cards 250-346px tall) passed it. This gate keeps
// the overflow test and adds the two things the owner actually saw: a squished
// info column and a tall card, at every common phone width.
//
// evaluateLayout() is pure (metrics in, problems out) so scripts/newsletter/
// mobile-layout-check.test.mjs can pin it without a browser. measureLayout()
// runs inside the page.

export const WIDTHS = [320, 360, 375, 390, 430];
export const LIMITS = {
  overflowSlack: 2,        // px the document may exceed the viewport
  minInfoWidth: 100,       // px: title / pills / date column of a show card
  // px: a show card (poster row + Critics' Take). Calibrated on real drafts
  // (3 weeks x 2 editions, 2026-10-26..11-09): worst healthy card at 320px is
  // 310 (a 5-line opera title); the squished layout the owner reported hit 346.
  // The info-column floor above is the sharp squish detector; this is the
  // backstop for a card that balloons for any other reason.
  maxCardHeight: 330,
  maxPillHeight: 24,       // px: a pill taller than this has wrapped
};

/** Runs in the browser. Returns plain numbers only. */
export function measureLayout() {
  // Judge only show cards: showCardHtml() stamps data-show-card, so group boxes
  // ("Biggest Movers"), quote cards and future 3-cell tables are not mistaken for
  // one (a 3-cell shape filter misjudged the movers box). A newsletter with no
  // show cards legitimately measures none; the test suite pins that
  // showCardHtml() emits the marker this selector looks for.
  const cards = [...document.querySelectorAll('table[data-show-card]')].flatMap((t) => {
    const info = t.querySelector('tr')?.children[1];
    if (!info) return [];
    return [{
      title: (t.querySelector('a[href*="/show/"]')?.getAttribute('href') || '').split('?')[0].split('/').pop() || '(card)',
      height: Math.round(t.getBoundingClientRect().height),
      infoWidth: Math.round(info.getBoundingClientRect().width),
    }];
  });
  const pills = [...document.querySelectorAll('.mp,.gp')].map((e) => ({
    text: (e.textContent || '').trim(),
    height: Math.round(e.getBoundingClientRect().height),
  }));
  return { docWidth: document.documentElement.scrollWidth, cards, pills };
}

/** @returns {string[]} human-readable problems, empty when the layout is fine */
export function evaluateLayout(width, m, limits = LIMITS) {
  const out = [];
  if (m.docWidth > width + limits.overflowSlack) out.push(`${width}px: email is ${m.docWidth}px wide (overflows the screen)`);
  for (const c of m.cards) {
    if (c.infoWidth < limits.minInfoWidth) out.push(`${width}px: "${c.title}" info column is only ${c.infoWidth}px wide (min ${limits.minInfoWidth}); title and venue will wrap to many lines`);
    if (c.height > limits.maxCardHeight) out.push(`${width}px: "${c.title}" card is ${c.height}px tall (max ${limits.maxCardHeight})`);
  }
  for (const p of m.pills) {
    if (p.height > limits.maxPillHeight) out.push(`${width}px: pill "${p.text}" wrapped (${p.height}px tall, max ${limits.maxPillHeight})`);
  }
  return out;
}
