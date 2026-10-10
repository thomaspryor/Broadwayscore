#!/usr/bin/env node
/**
 * Generate OG images for blog reviews at build time.
 * Produces 1200x630 PNG files in public/og/reviews/.
 *
 * Uses SVG templates + @resvg/resvg-js for conversion.
 * Run as part of prebuild or manually.
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const REVIEWS_DIR = path.join(__dirname, '../content/reviews');
const OUTPUT_DIR = path.join(__dirname, '../public/og/reviews');

// Score tier colors (mirrors ScoreBadge.tsx)
function getScoreColor(score) {
  if (score >= 83) return '#FFD700'; // Critical Gold
  if (score >= 75) return '#22c55e'; // Recommended (green)
  if (score >= 65) return '#14b8a6'; // Worth Seeing (teal)
  if (score >= 55) return '#f59e0b'; // Skippable (amber)
  return '#ef4444';                  // Critical Miss (red)
}

function getScoreLabel(score) {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Critical Miss';
}

// Wrap text to fit within maxWidth (approximate character limit per line)
function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateSvg(review) {
  const scoreColor = getScoreColor(review.score);
  const scoreLabel = getScoreLabel(review.score);
  const titleLines = wrapText(review.title, 35);
  const titleY = titleLines.length === 1 ? 280 : titleLines.length === 2 ? 250 : 220;

  const titleElements = titleLines.map((line, i) =>
    `<text x="80" y="${titleY + i * 65}" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="bold" fill="#ffffff">${escapeXml(line)}</text>`
  ).join('\n  ');

  const showInfoY = titleY + titleLines.length * 65 + 20;

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0f0f1a;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Top bar -->
  <text x="80" y="80" font-family="system-ui, -apple-system, sans-serif" font-size="24" fill="#d4a574" font-weight="600" letter-spacing="2">BROADWAY SCORECARD</text>
  <text x="80" y="115" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="#6b7280">REVIEW</text>

  <!-- Score badge -->
  <rect x="1000" y="50" width="130" height="130" rx="20" fill="${scoreColor}" opacity="0.15"/>
  <rect x="1000" y="50" width="130" height="130" rx="20" fill="none" stroke="${scoreColor}" stroke-width="3"/>
  <text x="1065" y="130" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="bold" fill="${scoreColor}" text-anchor="middle">${review.score}</text>
  <text x="1065" y="160" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="${scoreColor}" text-anchor="middle">${scoreLabel}</text>

  <!-- Title -->
  ${titleElements}

  <!-- Show info -->
  <text x="80" y="${showInfoY}" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#9ca3af">${escapeXml(review.show)} at ${escapeXml(review.venue)}</text>

  <!-- Footer -->
  <line x1="80" y1="560" x2="1120" y2="560" stroke="#374151" stroke-width="1"/>
  <text x="80" y="595" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#6b7280">broadwayscorecard.com/reviews</text>
</svg>`;
}

async function main() {
  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Read all blog reviews
  if (!fs.existsSync(REVIEWS_DIR)) {
    console.log('[og] No reviews directory found, skipping');
    return;
  }

  const files = fs.readdirSync(REVIEWS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));

  if (files.length === 0) {
    console.log('[og] No reviews found, skipping');
    return;
  }

  // Lazy-load resvg (may not be available in all environments)
  let Resvg;
  try {
    Resvg = require('@resvg/resvg-js').Resvg;
  } catch {
    console.warn('[og] @resvg/resvg-js not available, generating SVGs only');
  }

  let generated = 0;

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const pngPath = path.join(OUTPUT_DIR, `${slug}.png`);

    // Skip if PNG already exists and is newer than the markdown file
    const mdPath = path.join(REVIEWS_DIR, file);
    if (fs.existsSync(pngPath)) {
      const mdStat = fs.statSync(mdPath);
      const pngStat = fs.statSync(pngPath);
      if (pngStat.mtimeMs > mdStat.mtimeMs) {
        continue; // Already up to date
      }
    }

    const raw = fs.readFileSync(mdPath, 'utf8');
    const { data } = matter(raw);

    if (!data.title || !data.show || !data.venue || data.score === undefined) {
      console.warn(`[og] Skipping ${file}: missing required frontmatter`);
      continue;
    }

    const svg = generateSvg({
      title: data.title,
      show: data.show,
      venue: data.venue,
      score: Number(data.score),
    });

    // Save SVG
    fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.svg`), svg);

    // Convert to PNG if resvg is available
    if (Resvg) {
      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: 1200 },
      });
      const png = resvg.render().asPng();
      fs.writeFileSync(pngPath, png);
    }

    generated++;
    console.log(`[og] Generated: ${slug}.png`);
  }

  console.log(`[og] Done — ${generated} images generated, ${files.length - generated} up-to-date`);
}

main().catch(err => {
  console.error('[og] Error:', err);
  process.exit(1);
});
