#!/usr/bin/env node

/**
 * Social Media Image Generator
 *
 * Generates 1200x675 social card images using Playwright.
 * Visual design matches the OG route (dark theme, score badges, branding).
 *
 * Image types:
 *   show       - Show poster + score badge + title + review count
 *   box-office - Top 5 grossing shows ranked list
 *   picks      - 3-4 show thumbnails in a row with scores
 *   generic    - BroadwayScorecard branding + headline text
 *
 * Usage:
 *   const { generateSocialImage } = require('./social-image-generator');
 *   const imagePath = await generateSocialImage({ type: 'show', data: {...} });
 *
 * CLI test:
 *   node scripts/social-image-generator.js --test
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'public', 'images', 'shows');
const OUTPUT_PATH = '/tmp/social-image.png';

// Score colors (matching OG route: src/app/api/og/route.tsx)
const SCORE_COLORS = {
  mustSee: { bg: 'linear-gradient(135deg, #D4AF37 0%, #C5A028 50%, #D4AF37 100%)', text: '#1a1a1a', label: '#D4AF37' },
  great:   { bg: '#22c55e', text: '#ffffff', label: '#22c55e' },
  good:    { bg: '#14b8a6', text: '#ffffff', label: '#14b8a6' },
  tepid:   { bg: '#eab308', text: '#1a1a1a', label: '#eab308' },
  skip:    { bg: '#f97316', text: '#ffffff', label: '#f97316' },
  tbd:     { bg: '#2a2a2a', text: '#9ca3af', label: '#6b7280' },
};

function getScoreStyle(score, reviewCount) {
  if (!score || reviewCount < 5) return SCORE_COLORS.tbd;
  if (score >= 85) return SCORE_COLORS.mustSee;
  if (score >= 75) return SCORE_COLORS.great;
  if (score >= 65) return SCORE_COLORS.good;
  if (score >= 55) return SCORE_COLORS.tepid;
  return SCORE_COLORS.skip;
}

function getScoreLabel(score) {
  if (!score) return 'Awaiting Reviews';
  if (score >= 85) return 'Must-See';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Stay Away';
}

/**
 * Read a show's thumbnail as base64 data URL
 */
function getShowImageBase64(showId) {
  const extensions = ['thumbnail.webp', 'thumbnail.jpg', 'poster.webp', 'poster.jpg'];
  for (const ext of extensions) {
    const imgPath = path.join(IMAGES_DIR, showId, ext);
    if (fs.existsSync(imgPath)) {
      const data = fs.readFileSync(imgPath);
      const mime = ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return `data:${mime};base64,${data.toString('base64')}`;
    }
  }
  return null;
}

function formatGross(num) {
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `$${(num / 1000).toFixed(0)}K`;
  return `$${num}`;
}

// Branding footer HTML (shared across all templates)
const BRANDING_HTML = `
  <div style="position:absolute;bottom:28px;right:40px;display:flex;align-items:center;gap:0;">
    <span style="font-size:24px;font-weight:800;color:white;">Broadway</span>
    <span style="font-size:24px;font-weight:800;background:linear-gradient(to right,#8b5cf6,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Scorecard</span>
  </div>
`;

// Base page styles
const BASE_STYLES = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:1200px; height:675px;
    background:#0a0a0a;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    position:relative; overflow:hidden;
  }
  .gradient-overlay {
    position:absolute; top:0; left:0; right:0; bottom:0;
    background:radial-gradient(ellipse at top right, rgba(139,92,246,0.1), transparent 50%);
  }
`;

/**
 * Generate a "show" type social card
 */
function generateShowHTML(data) {
  const { title, score, reviewCount, venue, showId } = data;
  const style = getScoreStyle(score, reviewCount);
  const label = getScoreLabel(score);
  const imageData = showId ? getShowImageBase64(showId) : null;
  const displayScore = score && reviewCount >= 5 ? Math.round(score) : null;
  const titleSize = title.length > 25 ? '54px' : '64px';

  const posterHTML = imageData
    ? `<img src="${imageData}" style="width:280px;height:420px;border-radius:16px;object-fit:cover;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);">`
    : `<div style="width:280px;height:420px;background:#1a1a1a;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:100px;border:1px solid rgba(255,255,255,0.1);">&#127917;</div>`;

  const scoreBadgeShadow = displayScore && displayScore >= 85
    ? 'box-shadow:0 0 40px rgba(212,175,55,0.4);'
    : 'box-shadow:0 4px 24px rgba(0,0,0,0.3);';

  return `<!DOCTYPE html><html><head><style>
    ${BASE_STYLES}
  </style></head><body>
    <div class="gradient-overlay"></div>
    <div style="display:flex;width:100%;height:100%;padding:40px;gap:40px;">
      <div style="display:flex;align-items:center;justify-content:center;width:340px;flex-shrink:0;">
        ${posterHTML}
      </div>
      <div style="display:flex;flex-direction:column;justify-content:center;flex:1;gap:20px;">
        <div style="font-size:${titleSize};font-weight:800;color:white;line-height:1.1;letter-spacing:-0.02em;">${escapeHTML(title)}</div>
        ${venue ? `<div style="font-size:24px;color:#9ca3af;">${escapeHTML(venue)}</div>` : ''}
        <div style="display:flex;align-items:center;gap:20px;margin-top:12px;">
          <div style="width:100px;height:100px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:${displayScore ? '48px' : '28px'};font-weight:800;background:${style.bg};color:${style.text};${scoreBadgeShadow}">
            ${displayScore ?? 'TBD'}
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-size:28px;font-weight:700;color:${style.label};">${label}</div>
            <div style="font-size:18px;color:#6b7280;">${reviewCount || 0} Critic Review${reviewCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>
    </div>
    ${BRANDING_HTML}
  </body></html>`;
}

/**
 * Generate a "box-office" type social card
 */
function generateBoxOfficeHTML(data) {
  const { weekEnding, shows } = data;
  // shows: [{ rank, title, gross, capacity, change }]

  const rowsHTML = shows.slice(0, 5).map((show, i) => {
    const changeColor = show.change > 0 ? '#22c55e' : show.change < 0 ? '#ef4444' : '#6b7280';
    const changeSign = show.change > 0 ? '+' : '';
    const changeStr = show.change != null ? `${changeSign}${show.change.toFixed(1)}%` : '';

    return `
      <div style="display:flex;align-items:center;gap:16px;padding:12px 0;${i < 4 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : ''}">
        <div style="width:36px;font-size:28px;font-weight:800;color:${i < 3 ? '#D4AF37' : '#6b7280'};text-align:center;">${i + 1}</div>
        <div style="flex:1;font-size:22px;font-weight:600;color:white;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(show.title)}</div>
        <div style="font-size:22px;font-weight:700;color:#22c55e;width:100px;text-align:right;">${formatGross(show.gross)}</div>
        <div style="font-size:18px;color:#9ca3af;width:60px;text-align:right;">${show.capacity ? show.capacity + '%' : ''}</div>
        <div style="font-size:16px;color:${changeColor};width:70px;text-align:right;">${changeStr}</div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><style>
    ${BASE_STYLES}
  </style></head><body>
    <div class="gradient-overlay"></div>
    <div style="padding:40px 48px;display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:24px;">
        <div style="font-size:40px;font-weight:800;color:white;">This Week on Broadway</div>
        <div style="font-size:20px;color:#6b7280;">Week ending ${escapeHTML(weekEnding || '')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.15);margin-bottom:4px;">
        <div style="width:36px;font-size:14px;color:#6b7280;text-align:center;">#</div>
        <div style="flex:1;font-size:14px;color:#6b7280;">Show</div>
        <div style="font-size:14px;color:#6b7280;width:100px;text-align:right;">Gross</div>
        <div style="font-size:14px;color:#6b7280;width:60px;text-align:right;">Cap.</div>
        <div style="font-size:14px;color:#6b7280;width:70px;text-align:right;">WoW</div>
      </div>
      <div style="flex:1;">${rowsHTML}</div>
    </div>
    ${BRANDING_HTML}
  </body></html>`;
}

/**
 * Generate a "picks" type social card (3-4 shows)
 */
function generatePicksHTML(data) {
  const { headline, shows } = data;
  // shows: [{ title, score, reviewCount, showId }]

  const cardsHTML = shows.slice(0, 4).map(show => {
    const style = getScoreStyle(show.score, show.reviewCount);
    const imageData = show.showId ? getShowImageBase64(show.showId) : null;
    const displayScore = show.score && show.reviewCount >= 5 ? Math.round(show.score) : null;
    const cardWidth = shows.length <= 3 ? '280px' : '220px';
    const imgHeight = shows.length <= 3 ? '300px' : '250px';

    const imgHTML = imageData
      ? `<img src="${imageData}" style="width:100%;height:${imgHeight};border-radius:12px;object-fit:cover;border:1px solid rgba(255,255,255,0.1);">`
      : `<div style="width:100%;height:${imgHeight};background:#1a1a1a;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:60px;border:1px solid rgba(255,255,255,0.1);">&#127917;</div>`;

    return `
      <div style="width:${cardWidth};display:flex;flex-direction:column;gap:8px;">
        <div style="position:relative;">
          ${imgHTML}
          <div style="position:absolute;top:8px;right:8px;width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;background:${style.bg};color:${style.text};box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            ${displayScore ?? '?'}
          </div>
        </div>
        <div style="font-size:16px;font-weight:600;color:white;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(show.title)}</div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><style>
    ${BASE_STYLES}
  </style></head><body>
    <div class="gradient-overlay"></div>
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px;padding:40px;">
      <div style="font-size:40px;font-weight:800;color:white;">${escapeHTML(headline || 'Weekend Picks')}</div>
      <div style="display:flex;gap:24px;align-items:flex-start;justify-content:center;">
        ${cardsHTML}
      </div>
    </div>
    ${BRANDING_HTML}
  </body></html>`;
}

/**
 * Generate a "generic" type social card (headline + optional subtitle)
 */
function generateGenericHTML(data) {
  const { headline, subtitle } = data;

  return `<!DOCTYPE html><html><head><style>
    ${BASE_STYLES}
  </style></head><body>
    <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at center, rgba(139,92,246,0.2), transparent 60%);"></div>
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px;padding:60px;text-align:center;">
      <div style="font-size:${(headline || '').length > 50 ? '40px' : '52px'};font-weight:800;color:white;line-height:1.2;max-width:900px;">${escapeHTML(headline || 'Broadway Scorecard')}</div>
      ${subtitle ? `<div style="font-size:26px;color:#9ca3af;max-width:700px;line-height:1.4;">${escapeHTML(subtitle)}</div>` : ''}
    </div>
    ${BRANDING_HTML}
  </body></html>`;
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a social media image
 *
 * @param {Object} options
 * @param {'show'|'box-office'|'picks'|'generic'} options.type
 * @param {Object} options.data - Type-specific data
 * @param {string} [options.outputPath] - Override output path
 * @returns {Promise<string>} Absolute path to generated PNG
 */
async function generateSocialImage({ type, data, outputPath }) {
  const outPath = outputPath || OUTPUT_PATH;

  let html;
  switch (type) {
    case 'show':
      html = generateShowHTML(data);
      break;
    case 'box-office':
      html = generateBoxOfficeHTML(data);
      break;
    case 'picks':
      html = generatePicksHTML(data);
      break;
    case 'generic':
    default:
      html = generateGenericHTML(data);
      break;
  }

  // Launch Playwright and screenshot
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });

  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();

  console.log(`[ImageGen] Generated ${type} image: ${outPath}`);
  return outPath;
}

module.exports = { generateSocialImage };

// CLI test mode
if (require.main === module) {
  const arg = process.argv[2];

  async function runTest() {
    if (arg === '--test' || !arg) {
      console.log('Generating test images...');

      await generateSocialImage({
        type: 'show',
        data: {
          title: 'Maybe Happy Ending',
          score: 87,
          reviewCount: 35,
          venue: 'Belasco Theatre',
          showId: 'maybe-happy-ending-2024',
        },
        outputPath: '/tmp/social-test-show.png',
      });

      await generateSocialImage({
        type: 'box-office',
        data: {
          weekEnding: 'Feb 2, 2026',
          shows: [
            { title: 'Hamilton', gross: 2100000, capacity: 101, change: 2.3 },
            { title: 'The Lion King', gross: 1950000, capacity: 99, change: -1.1 },
            { title: 'Wicked', gross: 1800000, capacity: 98, change: 5.2 },
            { title: 'MJ The Musical', gross: 1200000, capacity: 88, change: 0 },
            { title: 'Maybe Happy Ending', gross: 950000, capacity: 82, change: 12.5 },
          ],
        },
        outputPath: '/tmp/social-test-boxoffice.png',
      });

      await generateSocialImage({
        type: 'picks',
        data: {
          headline: 'Weekend Picks',
          shows: [
            { title: 'Maybe Happy Ending', score: 87, reviewCount: 35, showId: 'maybe-happy-ending-2024' },
            { title: 'Stereophonic', score: 86, reviewCount: 22, showId: 'stereophonic-2024' },
            { title: 'The Great Gatsby', score: 79, reviewCount: 18, showId: 'the-great-gatsby-2024' },
          ],
        },
        outputPath: '/tmp/social-test-picks.png',
      });

      await generateSocialImage({
        type: 'generic',
        data: {
          headline: 'This season has the most Broadway shows in 20 years',
          subtitle: '52 shows and counting in the 2024-2025 season',
        },
        outputPath: '/tmp/social-test-generic.png',
      });

      console.log('Test images saved to /tmp/social-test-*.png');
    }
  }

  runTest().catch(console.error);
}
