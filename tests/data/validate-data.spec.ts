import { test, expect } from 'playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const dataDir = path.join(__dirname, '../../data');

test.describe('Data Validation', () => {
  let shows: any[];
  let reviews: any[];

  test.beforeAll(() => {
    // Load data files
    const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
    shows = showsData.shows || showsData;

    if (fs.existsSync(path.join(dataDir, 'reviews.json'))) {
      const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
      reviews = reviewsData.reviews || reviewsData || [];
    } else {
      reviews = [];
    }
  });

  test('shows.json is valid JSON with required structure', () => {
    expect(Array.isArray(shows)).toBeTruthy();
    expect(shows.length).toBeGreaterThan(0);
  });

  test('no duplicate show IDs', () => {
    const ids = shows.map((s: any) => s.id);
    const duplicates = ids.filter((id: string, i: number) => ids.indexOf(id) !== i);

    if (duplicates.length > 0) {
      throw new Error(`Duplicate show IDs found: ${[...new Set(duplicates)].join(', ')}`);
    }
  });

  test('no duplicate show slugs', () => {
    const slugs = shows.map((s: any) => s.slug);
    const duplicates = slugs.filter((slug: string, i: number) => slugs.indexOf(slug) !== i);

    if (duplicates.length > 0) {
      throw new Error(`Duplicate show slugs found: ${[...new Set(duplicates)].join(', ')}`);
    }
  });

  test('no duplicate show titles (normalized)', () => {
    const normalize = (title: string) =>
      title
        .toLowerCase()
        .replace(/:\s*.+$/, '')
        .replace(/\s+the\s+musical$/i, '')
        .replace(/\s+on\s+broadway$/i, '')
        .replace(/[!?'":\-–—,\.]/g, '')
        .trim();

    const normalizedTitles = shows.map((s: any) => ({
      original: s.title,
      normalized: normalize(s.title),
      id: s.id,
    }));

    const seen = new Map<string, any>();
    const duplicates: string[] = [];

    for (const show of normalizedTitles) {
      if (seen.has(show.normalized)) {
        const existing = seen.get(show.normalized);
        duplicates.push(`"${show.original}" (${show.id}) duplicates "${existing.original}" (${existing.id})`);
      } else {
        seen.set(show.normalized, show);
      }
    }

    if (duplicates.length > 0) {
      throw new Error(`Potential duplicate shows:\n${duplicates.join('\n')}`);
    }
  });

  test('all shows have required fields', () => {
    const requiredFields = ['id', 'title', 'slug', 'status'];
    const missing: string[] = [];

    for (const show of shows) {
      for (const field of requiredFields) {
        if (!show[field]) {
          missing.push(`${show.title || show.id || 'Unknown'} missing ${field}`);
        }
      }
    }

    if (missing.length > 0) {
      throw new Error(`Shows with missing required fields:\n${missing.slice(0, 20).join('\n')}`);
    }
  });

  test('all shows have valid status', () => {
    const validStatuses = ['open', 'closed', 'previews'];
    const invalid: string[] = [];

    for (const show of shows) {
      if (!validStatuses.includes(show.status)) {
        invalid.push(`${show.title} has invalid status: ${show.status}`);
      }
    }

    if (invalid.length > 0) {
      throw new Error(`Shows with invalid status:\n${invalid.join('\n')}`);
    }
  });

  test('open shows have venue', () => {
    const openShows = shows.filter((s: any) => s.status === 'open');
    const missingVenue = openShows.filter((s: any) => !s.venue || s.venue === 'TBA');

    // Allow some shows without venue (newly added)
    if (missingVenue.length > 5) {
      const names = missingVenue.map((s: any) => s.title).join(', ');
      throw new Error(`${missingVenue.length} open shows missing venue: ${names}`);
    }
  });

  test('dates are valid ISO format', () => {
    const invalid: string[] = [];
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    for (const show of shows) {
      if (show.openingDate && !dateRegex.test(show.openingDate)) {
        invalid.push(`${show.title} has invalid openingDate: ${show.openingDate}`);
      }
      if (show.closingDate && !dateRegex.test(show.closingDate)) {
        invalid.push(`${show.title} has invalid closingDate: ${show.closingDate}`);
      }
    }

    if (invalid.length > 0) {
      throw new Error(`Invalid dates:\n${invalid.join('\n')}`);
    }
  });

  test('closed shows have closing date', () => {
    const closedShows = shows.filter((s: any) => s.status === 'closed');
    const missingDate = closedShows.filter((s: any) => !s.closingDate);

    // Allow some historical shows without dates
    const percentage = (missingDate.length / closedShows.length) * 100;
    expect(percentage).toBeLessThan(30); // At least 70% should have closing dates
  });

  test('no shows with future closing dates marked as closed', () => {
    const today = new Date().toISOString().split('T')[0];
    const invalid: string[] = [];

    for (const show of shows) {
      if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
        invalid.push(`${show.title} is marked closed but closingDate is ${show.closingDate}`);
      }
    }

    if (invalid.length > 0) {
      throw new Error(`Shows incorrectly marked as closed:\n${invalid.join('\n')}`);
    }
  });

  test('slugs are URL-safe', () => {
    const invalid: string[] = [];
    const slugRegex = /^[a-z0-9-]+$/;

    for (const show of shows) {
      if (show.slug && !slugRegex.test(show.slug)) {
        invalid.push(`${show.title} has invalid slug: ${show.slug}`);
      }
    }

    if (invalid.length > 0) {
      throw new Error(`Invalid slugs:\n${invalid.join('\n')}`);
    }
  });

  test('no empty shows (placeholder entries)', () => {
    const empty = shows.filter(
      (s: any) =>
        (!s.title || s.title.trim() === '') &&
        (!s.slug || s.slug.trim() === '')
    );

    if (empty.length > 0) {
      throw new Error(`Found ${empty.length} empty/placeholder show entries`);
    }
  });
});

test.describe('Review Data Validation', () => {
  test('review-texts directories match shows', () => {
    const reviewTextsDir = path.join(dataDir, 'review-texts');

    if (!fs.existsSync(reviewTextsDir)) {
      test.skip();
      return;
    }

    const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
    const shows = showsData.shows || showsData;
    const showIds = new Set(shows.map((s: any) => s.id));

    const reviewDirs = fs
      .readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const orphanedDirs = reviewDirs.filter((dir) => !showIds.has(dir));

    // Allow a few orphaned directories (shows might have been removed)
    if (orphanedDirs.length > 5) {
      console.warn(`Orphaned review directories: ${orphanedDirs.join(', ')}`);
    }
  });
});

test.describe('Image Validation', () => {
  test('shows with images have valid URLs', () => {
    const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
    const shows = showsData.shows || showsData;

    const invalid: string[] = [];
    const urlRegex = /^https?:\/\/.+/;

    for (const show of shows) {
      if (show.images) {
        for (const [key, url] of Object.entries(show.images)) {
          if (url && typeof url === 'string' && !urlRegex.test(url)) {
            invalid.push(`${show.title} has invalid ${key} URL: ${url}`);
          }
        }
      }
    }

    if (invalid.length > 0) {
      throw new Error(`Invalid image URLs:\n${invalid.slice(0, 10).join('\n')}`);
    }
  });
});
