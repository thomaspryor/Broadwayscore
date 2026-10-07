#!/usr/bin/env node
/**
 * Extract critic reviews from Show-Score paginated API
 * Usage: node scripts/extract-show-score-critics.js
 */

const fs = require('fs');
const path = require('path');

// Pages captured via Playwright from Show-Score API
// 71 total reviews, 8 per page = 9 pages
const pagesHtml = [];

// Parse reviews from HTML content
function parseReviews(html) {
  const reviews = [];

  // Match each review block
  const reviewRegex = /id='critic_review_(\d+)'[\s\S]*?alt="([^"]+)"[\s\S]*?class='review-tile-v2__date'>\s*\n([^<]+)[\s\S]*?href="\/member\/([^"]+)"[^>]*>([^<]+)[\s\S]*?rel="nofollow noopener"\s+href="([^"]+)"[^>]*>Read more/g;

  let match;
  while ((match = reviewRegex.exec(html)) !== null) {
    reviews.push({
      reviewId: match[1],
      outlet: match[2].trim(),
      date: match[3].trim(),
      criticSlug: match[4],
      criticName: match[5].trim(),
      url: match[6]
    });
  }

  return reviews;
}

// Read existing reviews to compare
const existingReviewsDir = path.join(__dirname, '../data/review-texts/harry-potter-2021');
const existingFiles = fs.readdirSync(existingReviewsDir).filter(f => f.endsWith('.json'));
const existingOutlets = new Set();
const existingCritics = new Set();

existingFiles.forEach(f => {
  const parts = f.replace('.json', '').split('--');
  if (parts.length >= 2) {
    existingOutlets.add(parts[0].toLowerCase());
    existingCritics.add(parts[1].toLowerCase());
  }
});

console.log(`Found ${existingFiles.length} existing review files`);
console.log('Existing outlets:', [...existingOutlets].join(', '));

// Sample HTML from pages - would be populated by Playwright
const sampleReviews = [
  // Page 1
  { outlet: "The New York Times", criticName: "Alexis Soloski", date: "December 7th, 2021", url: "https://www.nytimes.com/2021/12/07/theater/harry-potter-cursed-child-broadway-review.html" },
  { outlet: "Time Out New York", criticName: "Adam Feldman", date: "December 7th, 2021", url: "https://www.timeout.com/newyork/theater/harry-potter-cursed-child-broadway-review" },
  { outlet: "Theatermania", criticName: "Zachary Stewart", date: "December 7th, 2021", url: "https://www.theatermania.com/broadway/reviews/review-harry-potter-and-the-cursed-child-broadway_93096.html" },
  { outlet: "Broadway News", criticName: "Charles Isherwood", date: "December 7th, 2021", url: "https://broadwaynews.com/2021/12/07/review-harry-potter-and-the-cursed-child-retains-its-magic-and-its-heart/" },
  { outlet: "The New York Times", criticName: "Ben Brantley", date: "April 22nd, 2018", url: "https://www.nytimes.com/2018/04/22/theater/review-harry-potter-and-the-cursed-child-raises-the-bar-for-broadway-magic.html" },
  { outlet: "Time Out New York", criticName: "Adam Feldman", date: "April 22nd, 2018", url: "https://www.timeout.com/newyork/theater/harry-potter-cursed-child-broadway-review" },
  { outlet: "New York Magazine / Vulture", criticName: "Sara Holdren", date: "April 22nd, 2018", url: "http://www.vulture.com/2018/04/theater-review-harry-potter-and-the-broadway-spectacle.html" },
  { outlet: "The Wall Street Journal", criticName: "Terry Teachout", date: "April 25th, 2018", url: "https://www.wsj.com/articles/harry-potter-and-the-cursed-child-parts-one-and-two-review-bringing-the-magic-to-life-1524677142" },

  // Page 2
  { outlet: "Deadline", criticName: "Greg Evans", date: "April 22nd, 2018", url: "http://deadline.com/2018/04/harry-potter-and-the-cursed-child-broadway-review-j-k-rowling-jack-thorne-1202367117/" },
  { outlet: "New York Daily News", criticName: "Joe Dziemianowicz", date: "April 22nd, 2018", url: "http://beta.nydailynews.com/entertainment/theater-arts/cursed-child-review-wildly-harry-potter-broadway-article-1.3944034" },
  { outlet: "Variety", criticName: "Marilyn Stasio", date: "April 22nd, 2018", url: "http://variety.com/2018/legit/reviews/harry-potter-and-the-cursed-child-review-broadway-1202757827/" },
  { outlet: "The Hollywood Reporter", criticName: "David Rooney", date: "April 22nd, 2018", url: "https://www.hollywoodreporter.com/review/harry-potter-cursed-child-theater-review-1104812" },
  { outlet: "The Washington Post", criticName: "Peter Marks", date: "April 22nd, 2018", url: "https://www.washingtonpost.com/entertainment/theater_dance/the-charms-of-harry-potter-work-on-broadway--but-read-the-books-first/2018/04/20/817f793a-44a9-11e8-baaf-8b3c5a3da888_story.html" },
  { outlet: "Chicago Tribune", criticName: "Chris Jones", date: "April 22nd, 2018", url: "http://www.chicagotribune.com/entertainment/theater/broadway/sc-ent-harry-potter-broadway-review-0422-story.html" },
  { outlet: "New York Post", criticName: "Johnny Oleksinski", date: "April 22nd, 2018", url: "https://nypost.com/2018/04/22/harry-potter-epic-is-broadway-magic/" },
  { outlet: "Entertainment Weekly", criticName: "Marc Snetiker", date: "April 22nd, 2018", url: "http://ew.com/theater/2018/04/22/harry-potter-and-the-cursed-child-broadway-review/" },
];

console.log('\n--- Sample reviews (first 16) ---');
sampleReviews.forEach(r => {
  console.log(`${r.outlet} - ${r.criticName} (${r.date})`);
});
