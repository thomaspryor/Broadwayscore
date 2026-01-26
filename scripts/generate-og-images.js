#!/usr/bin/env node
/**
 * Generate Static OG Images
 *
 * Creates static Open Graph images for social sharing since
 * API routes don't work with Next.js static export.
 *
 * Usage: node scripts/generate-og-images.js
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OG_DIR = path.join(PUBLIC_DIR, 'og');

// Ensure og directory exists
if (!fs.existsSync(OG_DIR)) {
  fs.mkdirSync(OG_DIR, { recursive: true });
}

// Create a simple SVG-based OG image (will be converted or used as fallback)
// Note: For best compatibility, you should replace this with an actual PNG
const homepageOgSvg = `
<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0f0f1a;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="600" y="250" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="bold" fill="#d4a84b" text-anchor="middle">Broadway</text>
  <text x="600" y="340" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="bold" fill="#ffffff" text-anchor="middle">Scorecard</text>
  <text x="600" y="420" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#9ca3af" text-anchor="middle">Every show. Every review. One score.</text>
  <text x="600" y="520" font-family="system-ui, -apple-system, sans-serif" font-size="24" fill="#6b7280" text-anchor="middle">broadwayscorecard.com</text>
</svg>
`.trim();

// Write SVG (fallback)
fs.writeFileSync(path.join(OG_DIR, 'home.svg'), homepageOgSvg);
console.log('✅ Created /public/og/home.svg');

// Create a simple HTML file that can be screenshot for PNG generation
const homepageOgHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1200px;
      height: 630px;
      background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1a 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .title {
      font-size: 72px;
      font-weight: bold;
    }
    .broadway { color: #d4a84b; }
    .scorecard { color: #ffffff; }
    .tagline {
      font-size: 28px;
      color: #9ca3af;
      margin-top: 20px;
    }
    .url {
      font-size: 24px;
      color: #6b7280;
      margin-top: 60px;
    }
  </style>
</head>
<body>
  <div class="title">
    <span class="broadway">Broadway</span><span class="scorecard">Scorecard</span>
  </div>
  <div class="tagline">Every show. Every review. One score.</div>
  <div class="url">broadwayscorecard.com</div>
</body>
</html>
`.trim();

fs.writeFileSync(path.join(OG_DIR, 'home.html'), homepageOgHtml);
console.log('✅ Created /public/og/home.html (for PNG generation)');

console.log('');
console.log('📸 To create PNG from HTML:');
console.log('   1. Open public/og/home.html in browser');
console.log('   2. Take screenshot at 1200x630');
console.log('   3. Save as public/og/home.png');
console.log('');
console.log('Or use Playwright:');
console.log('   npx playwright screenshot public/og/home.html public/og/home.png --viewport-size=1200,630');
