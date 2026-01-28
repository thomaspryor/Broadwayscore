import { describe, test, expect } from 'vitest';
import { getTierLabel } from '@/lib/scoring-labels';

describe('getTierLabel', () => {
  test('returns Must-See for score 85', () => {
    expect(getTierLabel(85).label).toBe('Must-See');
    expect(getTierLabel(85).colorClass).toBe('text-score-must-see');
  });

  test('returns Must-See for score 100', () => {
    expect(getTierLabel(100).label).toBe('Must-See');
  });

  test('returns Recommended for score 75', () => {
    expect(getTierLabel(75).label).toBe('Recommended');
    expect(getTierLabel(75).colorClass).toBe('text-score-great');
  });

  test('returns Worth Seeing for score 65', () => {
    expect(getTierLabel(65).label).toBe('Worth Seeing');
    expect(getTierLabel(65).colorClass).toBe('text-score-good');
  });

  test('returns Skippable for score 55', () => {
    expect(getTierLabel(55).label).toBe('Skippable');
    expect(getTierLabel(55).colorClass).toBe('text-score-tepid');
  });

  test('returns Stay Away for score 54', () => {
    expect(getTierLabel(54).label).toBe('Stay Away');
    expect(getTierLabel(54).colorClass).toBe('text-score-skip');
  });

  test('returns Stay Away for score 0', () => {
    expect(getTierLabel(0).label).toBe('Stay Away');
  });

  test('boundary: 84 is Recommended not Must-See', () => {
    expect(getTierLabel(84).label).toBe('Recommended');
  });

  test('rounds scores correctly', () => {
    expect(getTierLabel(84.5).label).toBe('Must-See');
    expect(getTierLabel(84.4).label).toBe('Recommended');
  });
});
