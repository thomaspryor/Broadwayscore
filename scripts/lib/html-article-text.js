'use strict';

// Pure article extraction shared by collection, Wayback and login recovery.
const cheerio = require('cheerio');
const { parseJsonLd } = require('./jsonld');
const { jsonLdBodyToText } = require('./jsonld-body-choice');

/**
 * Extract article text from JSON-LD structured data embedded in the page.
 * Many major outlets (NYT, WaPo, HR, USA Today, The Wrap, etc.) embed
 * the full article body in script[type="application/ld+json"] tags.
 */
function extractFromJsonLd(html) {
  try {
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let bestText = '';
    while ((match = ldRegex.exec(html)) !== null) {
      try {
        const items = parseJsonLd(match[1].trim());
        for (const item of items) {
          const body = item.articleBody || item.reviewBody || item.text;
          if (body && typeof body === 'string' && body.length > bestText.length) {
            const cleaned = jsonLdBodyToText(body);
            if (cleaned.length > bestText.length) {
              bestText = cleaned;
            }
          }
        }
      } catch (e) { /* malformed JSON-LD */ }
    }
    return bestText;
  } catch (e) {
    return '';
  }
}

/** Generic <p>-based article extraction (sidebar/cruft stripped). */
function extractParagraphText(html) {
  // Parse nested containers structurally. A closing div or an inline related
  // widget must not end the article before its remaining paragraphs.
  // htmlparser2 preserves the source entities for the existing prose decoder.
  const $ = cheerio.load(html, { xml: { xmlMode: false, decodeEntities: false } });
  $('script, style, nav, header, footer, aside').remove();
  $('div[class], section[class], ul[class]').each((_, node) => {
    const cls = $(node).attr('class').toLowerCase();
    const cruft = node.name === 'div'
      ? /sharedaddy|jp-relatedposts|sd-sharing|sd-like|wpcnt|related-posts|widget|sidebar|comment|author-bio|author-info|post-tags|post-meta|social-share|share-buttons|jnews_inline_related_post_wrapper/
      : node.name === 'section' ? /related|comments|author/ : /social|share|tag/;
    if (cruft.test(cls)) $(node).remove();
  });

  let text = $.html();
  let scoped = false;
  const containerSelectors = [
    'entry-content', 'post-content', 'article-body', 'review-content',
    'entry clearfix', 'article-content', 'post-body', 'story-body', 'review-body',
  ];
  for (const cls of containerSelectors) {
    const container = $('div[class]').filter((_, node) => $(node).attr('class').toLowerCase().includes(cls)).first();
    if (container.find('p').length >= 3) {
      text = container.html();
      scoped = true;
      break;
    }
  }

  // Retain the recovery pipeline's other article shapes, with structural
  // boundaries instead of a regex that stops at the first nested close tag.
  if (!scoped) {
    for (const selector of ['section.page', 'article', 'div[itemprop="articleBody"]']) {
      const container = $(selector).first();
      if (container.find('p').text().trim().length > 200) {
        text = container.html();
        break;
      }
    }
  }

  // Extract paragraph content
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(text)) !== null) {
    const pText = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for')) {
      paragraphs.push(pText);
    }
  }

  let result = paragraphs.join('\n\n');

  // Strip trailing blog cruft: author bios, pingbacks, related post lists
  // These patterns detect where the actual review ends and boilerplate begins
  const cruftPatterns = [
    /\n\nView all posts by \w+.*$/s,
    /\n\n\[&#8230;\].*$/s,
    /\n\nPingback:.*$/s,
    /\n\nAbout the Author.*$/si,
    /\n\nShare this:.*$/si,
    /\n\nLike this:.*$/si,
    /\n\nRelated\n.*$/si,
    /\n\nFiled Under:.*$/si,
    /\n\nTagged With:.*$/si,
  ];
  for (const pattern of cruftPatterns) {
    result = result.replace(pattern, '');
  }

  return result;
}

module.exports = { extractFromJsonLd, extractParagraphText };
