const fs = require('fs');
const html = fs.readFileSync('/tmp/theatrely-test.html', 'utf8');

// Look for post-content-text div
const richTextMatch = html.match(/<div class="post-content-text"[^>]*>([\s\S]*?)<\/div>\s*<div class="(?:sidebar|ad-block|author|join-section)/);

if (richTextMatch) {
  let content = richTextMatch[1];
  // Remove HTML tags but preserve paragraph breaks
  content = content.replace(/<\/p>/g, '\n\n');
  content = content.replace(/<br\s*\/?>/g, '\n');
  content = content.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  content = content.replace(/&amp;/g, '&');
  content = content.replace(/&lt;/g, '<');
  content = content.replace(/&gt;/g, '>');
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&#x27;/g, "'");
  content = content.replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
  content = content.trim();

  console.log('Found article content (' + content.length + ' chars):\n');
  console.log(content);
} else {
  // Try alternative selectors
  console.log('Looking for alternative selectors...');

  // List some divs with classes containing "rt" or "article"
  const divMatches = html.match(/<div class="[^"]*(?:rt|article|body|content)[^"]*"/g);
  if (divMatches) {
    console.log('Found these div classes:');
    [...new Set(divMatches)].slice(0, 20).forEach(m => console.log('  ' + m));
  }
}
