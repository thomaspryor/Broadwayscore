// Mobile-overflow gate for the weekly newsletter.
//
// Why this exists (2026-07-12): a single show with a long venue name
// ("Perelman Performing Arts Center (PAC NYC)") rendered inside a showRow whose
// meta line used `white-space:nowrap` forced the whole email to ~533px wide.
// iOS Gmail then zoomed the entire message OUT to fit the phone, so every card
// and number looked tiny ("too wide + too small"). Nothing in the static checks
// caught it because the blowout only shows up once the HTML is laid out.
//
// This gate RENDERS the generated HTML at iPhone width (375px) with headless
// Chromium and fails if the document is wider than MAX_WIDTH — i.e. if anything
// forces horizontal overflow a phone can't absorb. It runs after generate.mjs
// in newsletter-draft.yml and BLOCKS the draft (exit 1) so an over-wide email
// can never reach a subscriber again.
//
// Threshold: the email is designed at max-width 560 but must shrink to the
// viewport on mobile. A well-formed layout lands at ~375–390px (the West End
// edition measures 386). 420 leaves a small cushion for rounding while still
// catching a real blowout (the bug above was 533).

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const MAX_WIDTH = 420;
const VIEWPORT = 375;

const weekStart = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

const outDir = process.env.NEWSLETTER_OUT_DIR
  || path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
const htmlPath = path.join(outDir, `A-${weekStart}.html`);

if (!fs.existsSync(htmlPath)) {
  console.error(`overflow-check: missing HTML for week ${weekStart} at ${htmlPath}`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: VIEWPORT, height: 900 } });
  await page.goto('file://' + htmlPath);
  const { docWidth, widest } = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    // Narrow the blame to the widest LEAF element (no child is also over-wide),
    // so a failure message points at the actual offender, not its container.
    const over = [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 377);
    const leaves = over.filter(e => ![...e.children].some(c => c.getBoundingClientRect().width > 377));
    leaves.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const top = leaves[0];
    return {
      docWidth,
      widest: top ? {
        w: Math.round(top.getBoundingClientRect().width),
        tag: top.tagName,
        style: (top.getAttribute('style') || '').slice(0, 120),
        text: (top.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      } : null,
    };
  });

  if (docWidth > MAX_WIDTH) {
    console.error(`\n🛑 Newsletter overflows on mobile: ${docWidth}px wide at a ${VIEWPORT}px viewport (limit ${MAX_WIDTH}px).`);
    console.error('   iOS Gmail will zoom the whole email out to fit — everything renders tiny.');
    if (widest) {
      console.error(`   Widest offending element: ${widest.w}px <${widest.tag}> "${widest.text}"`);
      console.error(`   style: ${widest.style}`);
      console.error('   Common cause: white-space:nowrap on a long meta line (venue/date) forcing min-width.');
    }
    console.error('');
    process.exit(1);
  }

  console.log(`✓ Mobile overflow check OK for week ${weekStart}: ${docWidth}px at ${VIEWPORT}px viewport (limit ${MAX_WIDTH}px).`);
} finally {
  await browser.close();
}
