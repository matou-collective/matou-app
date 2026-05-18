import { describe, it, expect } from 'vitest';
import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  sameWeek,
  weekKey,
} from '../../src/lib/weekRange';

describe('weekRange', () => {
  describe('startOfWeek', () => {
    it('returns Monday 00:00 for a Wednesday', () => {
      // Wednesday 20 May 2026
      const d = new Date(2026, 4, 20, 14, 30, 15);
      const r = startOfWeek(d);
      expect(r.getFullYear()).toBe(2026);
      expect(r.getMonth()).toBe(4);
      expect(r.getDate()).toBe(18); // Mon 18 May
      expect(r.getHours()).toBe(0);
      expect(r.getMinutes()).toBe(0);
      expect(r.getSeconds()).toBe(0);
      expect(r.getMilliseconds()).toBe(0);
    });

    it('returns the same Monday for a Monday at 00:00', () => {
      const d = new Date(2026, 4, 18, 0, 0, 0);
      const r = startOfWeek(d);
      expect(r.getDate()).toBe(18);
      expect(r.getHours()).toBe(0);
    });

    it('rolls Sunday back to the preceding Monday', () => {
      // Sunday 24 May 2026
      const d = new Date(2026, 4, 24, 23, 59);
      const r = startOfWeek(d);
      expect(r.getDate()).toBe(18); // Mon 18 May
    });

    it('crosses month boundary', () => {
      // Thursday 30 April 2026
      const d = new Date(2026, 3, 30, 12);
      const r = startOfWeek(d);
      expect(r.getMonth()).toBe(3); // April
      expect(r.getDate()).toBe(27); // Mon 27 Apr
    });
  });

  describe('endOfWeek', () => {
    it('returns Sunday 23:59:59.999 for a Wednesday', () => {
      const d = new Date(2026, 4, 20, 14, 30);
      const r = endOfWeek(d);
      expect(r.getDate()).toBe(24); // Sun 24 May
      expect(r.getHours()).toBe(23);
      expect(r.getMinutes()).toBe(59);
      expect(r.getSeconds()).toBe(59);
      expect(r.getMilliseconds()).toBe(999);
    });
  });

  describe('addWeeks', () => {
    it('adds 1 week', () => {
      const d = new Date(2026, 4, 18); // Mon 18 May
      const r = addWeeks(d, 1);
      expect(r.getDate()).toBe(25); // Mon 25 May
    });

    it('subtracts via negative input', () => {
      const d = new Date(2026, 4, 18);
      const r = addWeeks(d, -2);
      expect(r.getMonth()).toBe(4);
      expect(r.getDate()).toBe(4); // Mon 4 May
    });

    it('does not mutate the input', () => {
      const d = new Date(2026, 4, 18);
      addWeeks(d, 5);
      expect(d.getDate()).toBe(18);
    });
  });

  describe('sameWeek', () => {
    it('returns true for two dates in the same Mon-Sun week', () => {
      const a = new Date(2026, 4, 19, 9); // Tue
      const b = new Date(2026, 4, 24, 23); // Sun
      expect(sameWeek(a, b)).toBe(true);
    });

    it('returns false for dates one day apart but in different weeks', () => {
      const a = new Date(2026, 4, 24, 23); // Sun
      const b = new Date(2026, 4, 25, 0);  // Mon
      expect(sameWeek(a, b)).toBe(false);
    });
  });

  describe('weekKey', () => {
    it('returns YYYY-MM-DD of the Monday', () => {
      const d = new Date(2026, 4, 22); // Fri
      expect(weekKey(d)).toBe('2026-05-18');
    });
  });
});
