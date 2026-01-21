/**
 * Review Deduplication and Merging
 *
 * Ensures consistency when running the agent multiple times.
 * Reviews are deduplicated based on:
 * 1. Exact URL match
 * 2. Same outlet + same critic
 * 3. Same outlet (if only one review per outlet expected)
 *
 * IMPORTANT: Merge strategy is deterministic - always picks the same winner
 */

import { NormalizedReview, ReviewMatch } from './types';

// ===========================================
// URL NORMALIZATION
// ===========================================

/**
 * Normalize URL for comparison
 * Removes trailing slashes, protocol, www, query params (optionally)
 */
export function normalizeUrl(url: string, stripQuery = false): string {
  try {
    const parsed = new URL(url);
    let normalized = parsed.hostname.replace(/^www\./, '') + parsed.pathname;
    normalized = normalized.replace(/\/+$/, ''); // Remove trailing slashes

    if (!stripQuery && parsed.search) {
      normalized += parsed.search;
    }

    return normalized.toLowerCase();
  } catch {
    // If URL parsing fails, just do basic normalization
    return url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
}

// ===========================================
// REVIEW MATCHING
// ===========================================

/**
 * Generate a unique key for a review
 * Used for deduplication and sorting
 */
export function getReviewKey(review: NormalizedReview): string {
  // Primary key: outlet ID + critic name (if available)
  const parts = [review.outletId];

  if (review.criticName) {
    // Normalize critic name
    const normalizedCritic = review.criticName
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-');
    parts.push(normalizedCritic);
  }

  return parts.join('::');
}

/**
 * Check if two reviews are duplicates
 */
export function areReviewsDuplicates(
  review1: NormalizedReview,
  review2: NormalizedReview
): ReviewMatch | null {
  // Different shows - not duplicates
  if (review1.showId !== review2.showId) {
    return null;
  }

  // Check exact URL match first (most reliable)
  if (review1.url && review2.url) {
    const url1 = normalizeUrl(review1.url);
    const url2 = normalizeUrl(review2.url);
    if (url1 === url2) {
      return {
        outletId: review1.outletId,
        criticName: review1.criticName,
        url: review1.url,
        matchType: 'exact_url',
      };
    }
  }

  // Check outlet + critic match
  if (review1.outletId === review2.outletId) {
    if (review1.criticName && review2.criticName) {
      const critic1 = review1.criticName.toLowerCase().trim();
      const critic2 = review2.criticName.toLowerCase().trim();
      if (critic1 === critic2) {
        return {
          outletId: review1.outletId,
          criticName: review1.criticName,
          matchType: 'outlet_critic',
        };
      }
      // Same outlet, different critics - NOT duplicates
      return null;
    }

    // Same outlet, at least one missing critic name - consider duplicates
    // (Some outlets only publish one review per show)
    return {
      outletId: review1.outletId,
      matchType: 'outlet_only',
    };
  }

  return null;
}

// ===========================================
// MERGE STRATEGY
// ===========================================

/**
 * Merge two duplicate reviews, picking the best data from each
 * Deterministic: always produces the same result regardless of input order
 */
export function mergeReviews(
  review1: NormalizedReview,
  review2: NormalizedReview
): NormalizedReview {
  // Sort by preference order (deterministic)
  // Prefer: has URL > has critic name > has pullQuote > earlier publish date
  const [primary, secondary] = [review1, review2].sort((a, b) => {
    // Prefer one with URL
    if (a.url && !b.url) return -1;
    if (!a.url && b.url) return 1;

    // Prefer one with critic name
    if (a.criticName && !b.criticName) return -1;
    if (!a.criticName && b.criticName) return 1;

    // Prefer one with pullQuote
    if (a.pullQuote && !b.pullQuote) return -1;
    if (!a.pullQuote && b.pullQuote) return 1;

    // Prefer earlier publish date (more reliable source usually publishes first)
    if (a.publishDate && b.publishDate) {
      const dateA = new Date(a.publishDate);
      const dateB = new Date(b.publishDate);
      return dateA.getTime() - dateB.getTime();
    }

    // Prefer one with publish date
    if (a.publishDate && !b.publishDate) return -1;
    if (!a.publishDate && b.publishDate) return 1;

    // Fallback: sort by outlet ID for determinism
    return a.outletId.localeCompare(b.outletId);
  });

  // Merge: use primary as base, fill in missing fields from secondary
  const merged: NormalizedReview = {
    showId: primary.showId,
    outletId: primary.outletId,
    outlet: primary.outlet,
    assignedScore: primary.assignedScore,
    bucket: primary.bucket,
    thumb: primary.thumb,
  };

  // Optional fields: prefer primary, fallback to secondary
  merged.criticName = primary.criticName || secondary.criticName;
  merged.url = primary.url || secondary.url;
  merged.publishDate = primary.publishDate || secondary.publishDate;
  merged.originalRating = primary.originalRating || secondary.originalRating;
  merged.designation = primary.designation || secondary.designation;
  merged.pullQuote = primary.pullQuote || secondary.pullQuote;

  return merged;
}

// ===========================================
// DEDUPLICATION
// ===========================================

/**
 * Deduplicate and merge a list of reviews
 * Returns a consistent, sorted list
 */
export function deduplicateReviews(
  reviews: NormalizedReview[]
): { deduplicated: NormalizedReview[]; duplicatesRemoved: number } {
  const reviewMap = new Map<string, NormalizedReview>();
  let duplicatesRemoved = 0;

  for (const review of reviews) {
    const key = getReviewKey(review);

    // Check if we already have a review with this key
    const existing = reviewMap.get(key);

    if (existing) {
      // Merge the reviews
      const merged = mergeReviews(existing, review);
      reviewMap.set(key, merged);
      duplicatesRemoved++;
    } else {
      // Also check for URL-based duplicates
      let foundUrlDupe = false;
      if (review.url) {
        const normalizedUrl = normalizeUrl(review.url);
        for (const [existingKey, existingReview] of reviewMap.entries()) {
          if (existingReview.url && normalizeUrl(existingReview.url) === normalizedUrl) {
            // URL duplicate - merge
            const merged = mergeReviews(existingReview, review);
            reviewMap.set(existingKey, merged);
            duplicatesRemoved++;
            foundUrlDupe = true;
            break;
          }
        }
      }

      if (!foundUrlDupe) {
        reviewMap.set(key, review);
      }
    }
  }

  // Convert to sorted array for consistent output
  const deduplicated = Array.from(reviewMap.values()).sort((a, b) => {
    // Sort by: outlet tier (implied by ID ordering), then outlet ID, then critic name
    const outletCompare = a.outletId.localeCompare(b.outletId);
    if (outletCompare !== 0) return outletCompare;

    const criticA = a.criticName || '';
    const criticB = b.criticName || '';
    return criticA.localeCompare(criticB);
  });

  return { deduplicated, duplicatesRemoved };
}

// ===========================================
// MERGE WITH EXISTING DATA
// ===========================================

/**
 * Merge new reviews with existing reviews for a show
 * Preserves existing data while adding new reviews
 */
export function mergeWithExisting(
  existingReviews: NormalizedReview[],
  newReviews: NormalizedReview[],
  showId: string
): {
  merged: NormalizedReview[];
  added: NormalizedReview[];
  updated: NormalizedReview[];
  unchanged: NormalizedReview[];
} {
  // Filter to relevant show
  const existingForShow = existingReviews.filter(r => r.showId === showId);
  const newForShow = newReviews.filter(r => r.showId === showId);

  const added: NormalizedReview[] = [];
  const updated: NormalizedReview[] = [];
  const unchanged: NormalizedReview[] = [];

  // Create a map of existing reviews by key
  const existingMap = new Map<string, NormalizedReview>();
  for (const review of existingForShow) {
    existingMap.set(getReviewKey(review), review);
  }

  // Process new reviews
  const mergedMap = new Map<string, NormalizedReview>();

  // First, add all existing reviews
  for (const review of existingForShow) {
    mergedMap.set(getReviewKey(review), review);
  }

  // Then process new reviews
  for (const newReview of newForShow) {
    const key = getReviewKey(newReview);
    const existing = existingMap.get(key);

    if (!existing) {
      // Completely new review
      added.push(newReview);
      mergedMap.set(key, newReview);
    } else {
      // Check if data has changed
      const hasChanges =
        newReview.assignedScore !== existing.assignedScore ||
        newReview.url !== existing.url ||
        newReview.criticName !== existing.criticName ||
        newReview.pullQuote !== existing.pullQuote;

      if (hasChanges) {
        // Merge, preferring existing data (unless new data fills gaps)
        const merged = mergeReviews(existing, newReview);
        updated.push(merged);
        mergedMap.set(key, merged);
      } else {
        unchanged.push(existing);
      }
    }
  }

  // Also check for URL-based matches we might have missed
  for (const newReview of newForShow) {
    if (!newReview.url) continue;

    const newKey = getReviewKey(newReview);
    if (mergedMap.has(newKey)) continue; // Already processed

    const normalizedUrl = normalizeUrl(newReview.url);
    let foundMatch = false;

    for (const [existingKey, existingReview] of existingMap.entries()) {
      if (existingReview.url && normalizeUrl(existingReview.url) === normalizedUrl) {
        // URL match - this is likely the same review under different outlet name
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch && !mergedMap.has(newKey)) {
      added.push(newReview);
      mergedMap.set(newKey, newReview);
    }
  }

  const merged = Array.from(mergedMap.values()).sort((a, b) => {
    return a.outletId.localeCompare(b.outletId) ||
      (a.criticName || '').localeCompare(b.criticName || '');
  });

  return { merged, added, updated, unchanged };
}

// ===========================================
// CONSISTENCY VALIDATION
// ===========================================

/**
 * Validate that reviews are consistent and complete
 */
export function validateReviews(
  reviews: NormalizedReview[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const review of reviews) {
    // Required fields
    if (!review.showId) {
      errors.push(`Review missing showId: ${review.outlet}`);
    }
    if (!review.outletId) {
      errors.push(`Review missing outletId: ${review.outlet}`);
    }
    if (!review.outlet) {
      errors.push(`Review missing outlet name for outletId: ${review.outletId}`);
    }
    if (review.assignedScore === undefined || review.assignedScore === null) {
      errors.push(`Review missing assignedScore: ${review.outlet}`);
    }
    if (!review.bucket) {
      errors.push(`Review missing bucket: ${review.outlet}`);
    }
    if (!review.thumb) {
      errors.push(`Review missing thumb: ${review.outlet}`);
    }

    // Score range
    if (review.assignedScore < 0 || review.assignedScore > 100) {
      errors.push(`Invalid assignedScore ${review.assignedScore}: ${review.outlet}`);
    }

    // Bucket/thumb consistency
    const expectedBucket =
      review.assignedScore >= 85 ? 'Rave' :
        review.assignedScore >= 70 ? 'Positive' :
          review.assignedScore >= 50 ? 'Mixed' : 'Pan';

    if (review.bucket !== expectedBucket) {
      errors.push(
        `Bucket mismatch for ${review.outlet}: score ${review.assignedScore} ` +
        `should be ${expectedBucket}, got ${review.bucket}`
      );
    }

    const expectedThumb =
      review.assignedScore >= 70 ? 'Up' :
        review.assignedScore >= 50 ? 'Flat' : 'Down';

    if (review.thumb !== expectedThumb) {
      errors.push(
        `Thumb mismatch for ${review.outlet}: score ${review.assignedScore} ` +
        `should be ${expectedThumb}, got ${review.thumb}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
