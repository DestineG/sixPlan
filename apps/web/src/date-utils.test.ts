import { describe, expect, it } from 'vitest';
import { addToDateOnly, localToday } from './date-utils';

describe('date shortcuts', () => {
  it('formats today using the local calendar date', () => {
    expect(localToday(new Date(2026, 7, 1, 23, 30))).toBe('2026-08-01');
  });

  it('adds days and weeks to a date-only value', () => {
    expect(addToDateOnly('2026-08-01', 1, 'day')).toBe('2026-08-02');
    expect(addToDateOnly('2026-08-01', 1, 'week')).toBe('2026-08-08');
  });

  it('adds natural months and clamps to the target month end', () => {
    expect(addToDateOnly('2025-01-31', 1, 'month')).toBe('2025-02-28');
    expect(addToDateOnly('2024-01-31', 1, 'month')).toBe('2024-02-29');
    expect(addToDateOnly('2026-11-30', 3, 'month')).toBe('2027-02-28');
  });
});
