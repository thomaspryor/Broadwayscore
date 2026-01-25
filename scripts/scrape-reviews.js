const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Extraction patterns for different outlets
const extractors = {
  'Theatrely': {
    selector: 'rich-text-block w-richtext',
    type: 'class'
  },
  'THEATRELY': {
    selector: 'rich-text-block w-richtext',
    type: 'class'
  },
  'New York Stage Review': {
    selector: 'entry-content',
    type: 'class'
  },
  'New York Theatre Guide': {
    selector: 'article-body',
    type: 'class'
  },
  'TheaterMania': {
    selector: 'css-content-container',
    type: 'class',
    fallbackToParagraphs: true
  },
  'Cititour': {
    selector: 'entry-content',
    type: 'class'
  },
  'Broadway News': {
    selector: 'entry-content',
    type: 'class'
  },
  'BROADWAY NEWS': {
    selector: 'entry-content',
    type: 'class'
  },
  'Variety': {
    selector: 'article-content',
    type: 'class'
  },
  'Vulture': {
    selector: 'article-content',
    type: 'class'
  },
  'The Wrap': {
    selector: 'post-content',
    type: 'class'
  },
  'TheWrap': {
    selector: 'post-content',
    type: 'class'
  },
  'The Hollywood Reporter': {
    selector: 'article-body-content',
    type: 'class'
  },
  'Deadline': {
    selector: 'article-body-content',
    type: 'class'
  },
  'The Daily Beast': {
    selector: 'Mobiledoc',
    type: 'class'
  },
  'Observer': {
    selector: 'entry-content',
    type: 'class'
  },
  'default': {
    selector: 'article',
    type: 'tag'
  }
};

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    };

    const req = protocol.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchPage(redirectUrl).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function extractText(html, outlet) {
  const config = extractors[outlet] || extractors['default'];

  // Special handling for TheaterMania - extract all <p> tags
  if (config.fallbackToParagraphs) {
    const paragraphs = [];
    const pRegex = /<p[^>]*>([^<]+)/g;
    let match;
    while ((match = pRegex.exec(html)) !== null) {
      const text = match[1].trim();
      // Skip very short paragraphs (navigation, ads, etc.)
      if (text.length > 50) {
        paragraphs.push(text);
      }
    }
    if (paragraphs.length > 0) {
      let content = paragraphs.join('\n\n');
      // Decode HTML entities
      content = content.replace(/&#8217;/g, "'");
      content = content.replace(/&#8220;/g, '"');
      content = content.replace(/&#8221;/g, '"');
      content = content.replace(/&#8211;/g, '–');
      content = content.replace(/&#8212;/g, '—');
      content = content.replace(/&amp;/g, '&');
      return content;
    }
  }

  let contentMatch;
  if (config.type === 'class') {
    // Try to find div with the class
    const regex = new RegExp(`<div[^>]*class="[^"]*${config.selector}[^"]*"[^>]*>([\\s\\S]*?)</div>\\s*(?:<div class="|</div>)`, 'i');
    contentMatch = html.match(regex);

    // If not found, try a more permissive match
    if (!contentMatch) {
      const regex2 = new RegExp(`class="[^"]*${config.selector}[^"]*"[^>]*>([\\s\\S]*?)</(div|article)>`, 'i');
      contentMatch = html.match(regex2);
    }
  } else {
    // Tag-based extraction
    const regex = new RegExp(`<${config.selector}[^>]*>([\\s\\S]*?)</${config.selector}>`, 'i');
    contentMatch = html.match(regex);
  }

  if (!contentMatch) {
    // Fallback: look for common article selectors
    const fallbacks = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];

    for (const fallback of fallbacks) {
      contentMatch = html.match(fallback);
      if (contentMatch) break;
    }
  }

  if (!contentMatch) {
    return null;
  }

  let content = contentMatch[1];

  // Remove figure/image blocks
  content = content.replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '');

  // Remove scripts and styles
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Convert paragraphs to newlines
  content = content.replace(/<\/p>/gi, '\n\n');
  content = content.replace(/<br\s*\/?>/gi, '\n');

  // Remove all HTML tags
  content = content.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  content = content.replace(/&amp;/g, '&');
  content = content.replace(/&lt;/g, '<');
  content = content.replace(/&gt;/g, '>');
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&#x27;/g, "'");
  content = content.replace(/&nbsp;/g, ' ');
  content = content.replace(/&#8217;/g, "'");
  content = content.replace(/&#8220;/g, '"');
  content = content.replace(/&#8221;/g, '"');
  content = content.replace(/&#8211;/g, '–');
  content = content.replace(/&#8212;/g, '—');
  content = content.replace(/&rsquo;/g, "'");
  content = content.replace(/&lsquo;/g, "'");
  content = content.replace(/&rdquo;/g, '"');
  content = content.replace(/&ldquo;/g, '"');
  content = content.replace(/&mdash;/g, '—');
  content = content.replace(/&ndash;/g, '–');

  // Clean up whitespace
  content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
  content = content.trim();

  return content;
}

async function scrapeReview(review) {
  try {
    console.log(`  Fetching: ${review.url}`);
    const html = await fetchPage(review.url);
    const text = extractText(html, review.outlet);

    if (!text || text.length < 300) {
      console.log(`    ⚠ Short or no content extracted (${text ? text.length : 0} chars)`);
      return null;
    }

    console.log(`    ✓ Extracted ${text.length} chars`);
    return text;
  } catch (err) {
    console.log(`    ✗ Error: ${err.message}`);
    return null;
  }
}

async function saveReviewText(review, fullText) {
  const showDir = path.join('data/review-texts', review.show);
  const filePath = path.join(showDir, review.file);

  // Read existing file
  const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Update with full text
  existing.fullText = fullText;
  existing.source = 'scraped';
  existing.scrapedAt = new Date().toISOString();

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
}

async function main() {
  const reviews = JSON.parse(fs.readFileSync('/tmp/scrapable-reviews.json', 'utf8'));

  // Get command line args
  const args = process.argv.slice(2);
  const outlet = args[0];
  const limit = parseInt(args[1]) || 10;

  // Filter by outlet if specified
  let toScrape = reviews;
  if (outlet) {
    toScrape = reviews.filter(r =>
      r.outlet.toLowerCase().includes(outlet.toLowerCase())
    );
    console.log(`Filtering to outlet: ${outlet} (${toScrape.length} reviews)`);
  }

  toScrape = toScrape.slice(0, limit);
  console.log(`Scraping ${toScrape.length} reviews...\n`);

  let success = 0;
  let failed = 0;

  for (const review of toScrape) {
    const text = await scrapeReview(review);
    if (text) {
      await saveReviewText(review, text);
      success++;
    } else {
      failed++;
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nDone! Success: ${success}, Failed: ${failed}`);
}

main().catch(console.error);
