/**
 * Unit tests for getCategoriesForRole in src/lib/data-creative.ts
 *
 * Guards the compound-role splitting added for GitHub issues #73/#125
 * (John Doyle director credits): "Director & Choreographer" and other
 * combined roles must map to their categories, while music-department
 * roles containing "Direction" must never leak into the director category.
 *
 * Run with: npx tsx --test tests/unit/creative-role-mapping.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { getCategoriesForRole } from '../../src/lib/data-creative';

const sorted = (role: string) => getCategoriesForRole(role).slice().sort();

describe('exact and case-insensitive matches', () => {
  test('Director maps to director', () => {
    assert.deepStrictEqual(sorted('Director'), ['director']);
  });
  test('lowercase drift still maps', () => {
    assert.deepStrictEqual(sorted('book writer'), ['playwright']);
  });
  test('Music & Lyrics maps to both (existing combined key)', () => {
    assert.deepStrictEqual(sorted('Music & Lyrics'), ['composer', 'lyricist']);
  });
  test('Co-Director maps to director', () => {
    assert.deepStrictEqual(sorted('Co-Director'), ['director']);
  });
  test('Book Writers (plural) maps to playwright', () => {
    assert.deepStrictEqual(sorted('Book Writers'), ['playwright']);
  });
});

describe('compound roles split on comma/ampersand/slash/and', () => {
  test('Director & Choreographer maps to director', () => {
    assert.deepStrictEqual(sorted('Director & Choreographer'), ['director']);
  });
  test('Director and Choreographer maps to director', () => {
    assert.deepStrictEqual(sorted('Director and Choreographer'), ['director']);
  });
  test('Book, Music, and Lyrics maps to all three', () => {
    assert.deepStrictEqual(sorted('Book, Music, and Lyrics'), ['composer', 'lyricist', 'playwright']);
  });
  test('Book/Music/Lyrics maps to all three', () => {
    assert.deepStrictEqual(sorted('Book/Music/Lyrics'), ['composer', 'lyricist', 'playwright']);
  });
  test('Composer/Lyricist maps to both', () => {
    assert.deepStrictEqual(sorted('Composer/Lyricist'), ['composer', 'lyricist']);
  });
  test('Book & Music maps to playwright + composer', () => {
    assert.deepStrictEqual(sorted('Book & Music'), ['composer', 'playwright']);
  });
  test('Book & Director maps to playwright + director', () => {
    assert.deepStrictEqual(sorted('Book & Director'), ['director', 'playwright']);
  });
  test('Book, Director maps to playwright + director', () => {
    assert.deepStrictEqual(sorted('Book, Director'), ['director', 'playwright']);
  });
});

describe('music-department roles never leak into director', () => {
  test('Music Director maps to nothing', () => {
    assert.deepStrictEqual(sorted('Music Director'), []);
  });
  test('Music Direction maps to nothing', () => {
    assert.deepStrictEqual(sorted('Music Direction'), []);
  });
  test('Music Supervision & Direction maps to nothing (bare Direction part must not match)', () => {
    assert.deepStrictEqual(sorted('Music Supervision & Direction'), []);
  });
  test('Music Direction & Arrangements maps to nothing', () => {
    assert.deepStrictEqual(sorted('Music Direction & Arrangements'), []);
  });
  test('Original Music and Sound Design maps to nothing', () => {
    assert.deepStrictEqual(sorted('Original Music and Sound Design'), []);
  });
  test('Associate Director maps to nothing', () => {
    assert.deepStrictEqual(sorted('Associate Director'), []);
  });
  test('excluded roles are case-insensitive (music direction lowercase)', () => {
    assert.deepStrictEqual(sorted('music direction'), []);
  });
  test('Music Supervisor & Director maps to nothing (music-context Director part)', () => {
    assert.deepStrictEqual(sorted('Music Supervisor & Director'), []);
  });
  test('Music Supervision/Director maps to nothing', () => {
    assert.deepStrictEqual(sorted('Music Supervision/Director'), []);
  });
});

describe('unknown roles', () => {
  test('Choreographer alone maps to nothing', () => {
    assert.deepStrictEqual(sorted('Choreographer'), []);
  });
  test('word containing "and" does not split (Sound Designer)', () => {
    assert.deepStrictEqual(sorted('Sound Designer'), []);
  });
});
