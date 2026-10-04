/**
 * reddit-post-screenshots.js (BRO-4597)
 *
 * Phone-shaped screenshots of a show page for the owner's Reddit posts, so
 * they don't have to take them by hand. Their own desktop screenshots came out
 * wide, and the Reddit app crops a wide gallery image on both sides (the show
 * title and poster were cut off). These are taken at an iPhone-width viewport
 * and clipped to at most 4:5 (portrait), which the app shows uncropped.
 *
 *   scorecard.png  the top card: title, score, verdict, breakdown
 *   reviews.png    the Critic Scorecard bar plus a compact list of reviews
 *                  (quotes and bylines hidden: score, outlet, date per row)
 *   audience.png   the Audience Scorecard: grade plus every audience source
 *                  (skipped when the show has no audience card yet)
 *
 * clipRect() is pure and tested; captureShowImages() drives Playwright and
 * never throws: a failed capture returns [] and the email goes out without
 * images.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWPORT = { width: 430, height: 932 }; // iPhone Pro Max CSS pixels
const SCALE = 3; // 1290px-wide PNGs, the iPhone's own screenshot width
const MAX_ASPECT = 1.25; // height / width; Reddit's feed shows up to 4:5 uncropped
const PAD = 12; // breathing room around the card, CSS px

// css: injected for that shot only, removed before the next one.
// optional: the card is often absent (previews, too few audience reviews), so
// a miss is skipped at once instead of waiting out the visibility timeout.
const SHOTS = [
  { name: 'scorecard.png', selector: '[data-testid="show-hero-redesign"], [data-testid="show-header-card"]', label: 'Score card' },
  {
    // :has(article): before press night the section is a "Reviews coming" placeholder.
    name: 'reviews.png', selector: '#critic-reviews:has(article)', label: 'Critic reviews',
    // The owner posts the review list, many rows to one image. Each pull
    // quote is 4-6 lines at phone width, so with quotes only one review fit.
    // The indented block under each row (ReviewsList.tsx, pl-24) holds the
    // quote <p> and the byline/Full Review row <div>; both go. Its "earlier
    // run" tag is a <span> and stays, so an old review never reads as current.
    // The Sort row is a page control, not content.
    css: '#critic-reviews article [class*="pl-24"] > p, #critic-reviews article [class*="pl-24"] > div, #critic-reviews div:has(> button):not(:has(article)):not(article *) { display: none !important; }',
  },
  // The real card only (AudienceBuzzCard). In previews the same slot holds an
  // "Audience data will be added" placeholder, which is not worth posting.
  { name: 'audience.png', selector: 'section[aria-labelledby="audience-scorecard-heading"]', label: 'Audience grade', optional: true },
];

/**
 * Where to end a too-tall image: in the lowest clear gap between sections
 * that fits under maxBottom. blocks are the boxes ({top, bottom}) of the
 * card's text and image elements. A gap is a band at least minGap tall that no
 * block overlaps; cutting there never slices a line of text or a picture, and
 * never leaves a section label stranded above its cut-off content (labels sit
 * close to what they label). Returns the gap's midpoint, or null.
 */
function cleanCut(blocks, maxBottom, { minGap = 16 } = {}) {
  const sorted = blocks.filter(b => b.bottom > b.top).slice().sort((a, b) => a.top - b.top);
  let reach = -Infinity; // lowest bottom seen so far
  let best = null;
  for (const b of sorted) {
    if (reach > -Infinity && b.top - reach >= minGap) {
      const mid = Math.round((reach + b.top) / 2);
      if (mid <= maxBottom) best = mid;
    }
    reach = Math.max(reach, b.bottom);
  }
  return best;
}

/**
 * The clip for one element box: padded, inside the page width, and no taller
 * than MAX_ASPECT so the image never needs cropping on Reddit. A card taller
 * than that ends at the last clean edge (cleanCut) above the limit.
 */
function clipRect(box, pageWidth, { pad = PAD, maxAspect = MAX_ASPECT, blocks = [] } = {}) {
  const x = Math.max(0, Math.floor(box.x - pad));
  const right = Math.min(pageWidth, Math.ceil(box.x + box.width + pad));
  const width = right - x;
  const y = Math.max(0, Math.floor(box.y - pad));
  const maxHeight = Math.floor(width * maxAspect);
  let height = Math.ceil(box.height + 2 * pad);
  if (height > maxHeight) {
    const cut = cleanCut(blocks, y + maxHeight - pad);
    // The cut is a gap midpoint, so it already has breathing room: no pad.
    height = cut != null && cut - y > maxHeight / 2 ? Math.min(maxHeight, cut - y) : maxHeight;
  }
  return { x, y, width, height };
}

// Runs in the page, after each scroll: sticky headers appear on scroll and
// land on top of lower cards, and a logo that failed to load would show as a
// broken-image icon in an empty white badge.
/* istanbul ignore next */
function tidyForScreenshot() {
  for (const e of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(e).position;
    if (pos === 'fixed' || pos === 'sticky') e.style.setProperty('display', 'none', 'important');
  }
  for (const img of document.images) {
    if (!img.complete || img.naturalWidth > 0) continue;
    const badge = img.parentElement && img.parentElement.getBoundingClientRect().width <= 64 ? img.parentElement : img;
    badge.style.setProperty('visibility', 'hidden', 'important');
  }
}

async function captureShowImages(url, outDir, { chromium = null, executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, log = console.log } = {}) {
  let browser;
  try {
    const pw = chromium || require('playwright').chromium;
    fs.mkdirSync(outDir, { recursive: true });
    browser = await pw.launch({ executablePath });
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: 'dark', isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    // 'load', then wait for the card itself: analytics keep a page from ever
    // going network-idle, which would burn the timeout for no images.
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    // Cookie/consent banners and sticky bars would sit on top of the card.
    await page.addStyleTag({ content: '[role="dialog"], [data-testid*="cookie" i], [data-testid*="consent" i], [aria-label="Add to watchlist"], [aria-label="Remove from watchlist"], [aria-label^="Your rating"] { display: none !important; }' });
    await page.waitForTimeout(800);
    const out = [];
    for (const shot of SHOTS) {
      const el = page.locator(shot.selector).first();
      let style = null;
      try {
        if (shot.optional && (await el.count()) === 0) {
          log(`  screenshot ${shot.name} skipped (not on this page)`);
          continue;
        }
        if (shot.css) style = await page.addStyleTag({ content: shot.css });
        await el.waitFor({ state: 'visible', timeout: 15_000 });
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await page.evaluate(tidyForScreenshot);
        // Page coordinates, so the clip works however far down the card sits.
        const { box, blocks } = await el.evaluate(n => {
          const abs = r => ({ top: r.top + scrollY, bottom: r.bottom + scrollY });
          const r = n.getBoundingClientRect();
          // Text-bearing and image elements: a cut through one shows half a line.
          const leaves = [...n.querySelectorAll('*')].filter(e => {
            const cr = e.getBoundingClientRect();
            if (!cr.height || !cr.width) return false;
            if (/^(IMG|SVG|PICTURE|VIDEO|CANVAS|BUTTON)$/i.test(e.tagName)) return true;
            return [...e.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
          });
          return { box: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }, blocks: leaves.map(e => abs(e.getBoundingClientRect())) };
        });
        const file = path.join(outDir, shot.name);
        await page.screenshot({ path: file, clip: clipRect(box, VIEWPORT.width, { blocks }), fullPage: true });
        out.push({ file, name: shot.name, label: shot.label });
      } catch (e) {
        log(`  screenshot ${shot.name} skipped (${e.message.split('\n')[0]})`);
      } finally {
        if (style) await style.evaluate(n => n.remove()).catch(() => {});
      }
    }
    return out;
  } catch (e) {
    log(`  screenshots skipped (${e.message.split('\n')[0]})`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { clipRect, cleanCut, captureShowImages, SHOTS, VIEWPORT, SCALE, MAX_ASPECT };
