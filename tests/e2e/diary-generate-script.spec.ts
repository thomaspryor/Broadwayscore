import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const dataDir = path.join(__dirname, '../../data');
const publicDataDir = path.join(__dirname, '../../public/data');
const scriptPath = path.join(__dirname, '../../scripts/generate-diary-data.js');

test.describe('Generate Diary Data Script', () => {
  // These tests share mutable filesystem state (data/diary-shows.json input,
  // public/data/diary-*.json outputs) — under fullyParallel + multiple workers
  // they race: one test's execSync write can truncate a file mid-read by
  // another, producing "Unexpected end of JSON input". Must run serially.
  test.describe.configure({ mode: 'serial' });

  test('script runs without errors', () => {
    if (!fs.existsSync(path.join(dataDir, 'diary-shows.json'))) {
      test.skip(true, 'diary-shows.json not available');
      return;
    }

    const result = execSync(`node ${scriptPath}`, { encoding: 'utf8', timeout: 30000 });
    expect(result).toContain('Generated');
  });

  test('produces valid diary-search.json', () => {
    const searchPath = path.join(publicDataDir, 'diary-search.json');
    if (!fs.existsSync(searchPath)) { test.skip(); return; }

    const data = JSON.parse(fs.readFileSync(searchPath, 'utf8'));
    expect(Array.isArray(data)).toBeTruthy();

    // If data exists, verify structure
    if (data.length > 0) {
      // Every entry should have title and dy flag
      for (const entry of data.slice(0, 100)) {
        expect(entry.title).toBeTruthy();
        expect(entry.dy).toBe(true);
        expect(entry.status).toBeTruthy();
      }
    }
  });

  test('produces valid diary-lookup.json', () => {
    const lookupPath = path.join(publicDataDir, 'diary-lookup.json');
    if (!fs.existsSync(lookupPath)) { test.skip(); return; }

    const data = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
    expect(Array.isArray(data)).toBeTruthy();

    if (data.length > 0) {
      for (const entry of data.slice(0, 100)) {
        expect(entry.id).toBeTruthy();
        expect(entry.t).toBeTruthy();
        expect(entry.s).toBeTruthy();
        expect(entry.dy).toBe(1);
      }
    }
  });

  test('generates empty files when diary-shows.json is missing', () => {
    // diary-shows.json is a symlink into the private data repo (same as
    // data/shows.json) — renaming it out of place, even briefly, is the same
    // class of race the validate-data sentinel test hit (task #1649). Point
    // the script at a guaranteed-absent path via DIARY_SHOWS_JSON instead of
    // touching the real file at all.
    const missingPath = path.join(dataDir, `.diary-shows-missing-${process.pid}.json`);

    execSync(`node ${scriptPath}`, {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, DIARY_SHOWS_JSON: missingPath },
    });

    const search = JSON.parse(fs.readFileSync(path.join(publicDataDir, 'diary-search.json'), 'utf8'));
    const lookup = JSON.parse(fs.readFileSync(path.join(publicDataDir, 'diary-lookup.json'), 'utf8'));

    expect(search).toEqual([]);
    expect(lookup).toEqual([]);

    // Regenerate with real data so subsequent tests in this file (and any
    // other consumer of public/data/diary-*.json) see the correct output.
    execSync(`node ${scriptPath}`, { encoding: 'utf8', timeout: 30000 });
  });
});
