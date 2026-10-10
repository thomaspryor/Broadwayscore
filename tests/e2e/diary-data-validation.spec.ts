import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const publicDataDir = path.join(__dirname, '../../public/data');

test.describe('Diary Data Validation', () => {
  let searchData: any[];
  let lookupData: any[];

  test.beforeAll(() => {
    const searchPath = path.join(publicDataDir, 'diary-search.json');
    const lookupPath = path.join(publicDataDir, 'diary-lookup.json');

    if (!fs.existsSync(searchPath) || !fs.existsSync(lookupPath)) {
      // Files may not exist in CI without private data — tests will skip
      searchData = [];
      lookupData = [];
      return;
    }

    searchData = JSON.parse(fs.readFileSync(searchPath, 'utf8'));
    lookupData = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
  });

  test('diary-search.json is valid JSON array', () => {
    if (searchData.length === 0) { test.skip(); return; }
    expect(Array.isArray(searchData)).toBeTruthy();
  });

  test('diary-lookup.json is valid JSON array', () => {
    if (lookupData.length === 0) { test.skip(); return; }
    expect(Array.isArray(lookupData)).toBeTruthy();
  });

  test('all search entries have a title', () => {
    if (searchData.length === 0) { test.skip(); return; }
    const missing = searchData.filter((e: any) => !e.title);
    expect(missing.length).toBe(0);
  });

  test('single-production entries have id and slug', () => {
    if (searchData.length === 0) { test.skip(); return; }
    const singles = searchData.filter((e: any) => !e.prods);
    const missingId = singles.filter((e: any) => !e.id);
    const missingSlug = singles.filter((e: any) => !e.slug);
    expect(missingId.length).toBe(0);
    expect(missingSlug.length).toBe(0);
  });

  test('multi-production entries have gid and prods array', () => {
    if (searchData.length === 0) { test.skip(); return; }
    const multis = searchData.filter((e: any) => e.prods);
    const missingGid = multis.filter((e: any) => !e.gid);
    const emptyProds = multis.filter((e: any) => !Array.isArray(e.prods) || e.prods.length === 0);
    expect(missingGid.length).toBe(0);
    expect(emptyProds.length).toBe(0);
  });

  test('multi-production n field matches prods length', () => {
    if (searchData.length === 0) { test.skip(); return; }
    const multis = searchData.filter((e: any) => e.prods);
    const mismatched = multis.filter((e: any) => e.n !== e.prods.length);
    expect(mismatched.length).toBe(0);
  });

  test('all nested productions have id', () => {
    if (searchData.length === 0) { test.skip(); return; }
    const multis = searchData.filter((e: any) => e.prods);
    const allProds = multis.flatMap((e: any) => e.prods);
    const missingId = allProds.filter((p: any) => !p.id);
    expect(missingId.length).toBe(0);
  });

  test('all production IDs in search exist in lookup', () => {
    if (searchData.length === 0 || lookupData.length === 0) { test.skip(); return; }

    const lookupIds = new Set(lookupData.map((e: any) => e.id));
    const multis = searchData.filter((e: any) => e.prods);
    const prodIds = multis.flatMap((e: any) => e.prods.map((p: any) => p.id));
    const singles = searchData.filter((e: any) => !e.prods).map((e: any) => e.id);
    const allIds = [...prodIds, ...singles];

    const notInLookup = allIds.filter(id => !lookupIds.has(id));
    expect(notInLookup.length).toBe(0);
  });

  test('all lookup entries have required fields', () => {
    if (lookupData.length === 0) { test.skip(); return; }
    const missing: string[] = [];
    for (const entry of lookupData) {
      if (!entry.id) missing.push(`missing id: ${JSON.stringify(entry).slice(0, 80)}`);
      if (!entry.t) missing.push(`missing title: ${entry.id}`);
      if (!entry.s) missing.push(`missing slug: ${entry.id}`);
    }
    expect(missing.length).toBe(0);
  });

  test('no duplicate IDs in lookup', () => {
    if (lookupData.length === 0) { test.skip(); return; }
    const ids = lookupData.map((e: any) => e.id);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes.length).toBe(0);
  });

  test('search data is show-grouped (no more entries than lookup)', () => {
    if (searchData.length === 0 || lookupData.length === 0) { test.skip(); return; }
    // search should have at most as many entries as lookup (grouped by show)
    expect(searchData.length).toBeLessThanOrEqual(lookupData.length);
  });

  test('diary-search.json size is reasonable (< 10MB)', () => {
    const searchPath = path.join(publicDataDir, 'diary-search.json');
    if (!fs.existsSync(searchPath)) { test.skip(); return; }
    const stats = fs.statSync(searchPath);
    expect(stats.size).toBeLessThan(10 * 1024 * 1024);
  });
});
